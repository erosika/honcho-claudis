import Honcho from "@honcho-ai/core";
import { loadConfig, getSessionForPath } from "../config.js";
import { basename } from "path";
import {
  getCachedWorkspaceId,
  getCachedPeerId,
  getCachedSessionId,
  getCachedEriContext,
  isContextCacheStale,
  setCachedEriContext,
  queueMessage,
} from "../cache.js";

interface HookInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

// Patterns to skip heavy context retrieval
const SKIP_CONTEXT_PATTERNS = [
  /^(yes|no|ok|sure|thanks|y|n|yep|nope|yeah|nah|continue|go ahead|do it|proceed)$/i,
  /^\//, // slash commands
  /^.{1,19}$/, // very short (< 20 chars)
];

function shouldSkipContextRetrieval(prompt: string): boolean {
  return SKIP_CONTEXT_PATTERNS.some((p) => p.test(prompt.trim()));
}

function getSessionName(cwd: string): string {
  const configuredSession = getSessionForPath(cwd);
  if (configuredSession) {
    return configuredSession;
  }
  const dirName = basename(cwd).toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  return `project-${dirName}`;
}

export async function handleUserPrompt(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    process.exit(0);
  }

  let hookInput: HookInput = {};
  try {
    const input = await Bun.stdin.text();
    if (input.trim()) {
      hookInput = JSON.parse(input);
    }
  } catch {
    process.exit(0);
  }

  const prompt = hookInput.prompt || "";
  const cwd = hookInput.cwd || process.cwd();

  // Skip empty prompts
  if (!prompt.trim()) {
    process.exit(0);
  }

  // CRITICAL: Save message to local queue FIRST (instant, ~1-3ms)
  // This survives ctrl+c, network failures, everything
  if (config.saveMessages !== false) {
    queueMessage(prompt, config.peerName, cwd);
  }

  // Fire-and-forget: Upload to Honcho in background
  // This doesn't block the user
  if (config.saveMessages !== false) {
    uploadMessageAsync(config, cwd, prompt).catch(() => {});
  }

  // For trivial prompts, skip heavy context retrieval
  if (shouldSkipContextRetrieval(prompt)) {
    process.exit(0);
  }

  // Check if we have fresh cached context
  const cachedContext = getCachedEriContext();
  if (cachedContext && !isContextCacheStale()) {
    // Use cached context - instant response
    const contextParts = formatCachedContext(cachedContext, config.peerName);
    if (contextParts.length > 0) {
      outputContext(config.peerName, contextParts);
    }
    process.exit(0);
  }

  // Fetch fresh context (only for non-trivial prompts with stale cache)
  try {
    const contextParts = await fetchFreshContext(config, cwd, prompt);
    if (contextParts.length > 0) {
      outputContext(config.peerName, contextParts);
    }
  } catch {
    // Context fetch failed, continue without
  }

  process.exit(0);
}

async function uploadMessageAsync(config: any, cwd: string, prompt: string): Promise<void> {
  const workspaceId = getCachedWorkspaceId(config.workspace);
  const sessionId = getCachedSessionId(cwd);

  if (!workspaceId || !sessionId) {
    // No cache, need to do full setup - but do it in background
    const client = new Honcho({
      apiKey: config.apiKey,
      environment: "production",
    });

    const workspace = await client.workspaces.getOrCreate({ id: config.workspace });
    const sessionName = getSessionName(cwd);
    const session = await client.workspaces.sessions.getOrCreate(workspace.id, {
      id: sessionName,
      metadata: { cwd },
    });

    await client.workspaces.sessions.messages.create(workspace.id, session.id, {
      messages: [{ content: prompt, peer_id: config.peerName }],
    });
    return;
  }

  // Use cached IDs - fast path
  const client = new Honcho({
    apiKey: config.apiKey,
    environment: "production",
  });

  await client.workspaces.sessions.messages.create(workspaceId, sessionId, {
    messages: [{ content: prompt, peer_id: config.peerName }],
  });
}

function formatCachedContext(context: any, peerName: string): string[] {
  const parts: string[] = [];

  if (context?.representation?.explicit?.length) {
    const explicit = context.representation.explicit
      .slice(0, 5)
      .map((e: any) => e.content || e)
      .join("; ");
    parts.push(`Relevant facts: ${explicit}`);
  }

  if (context?.representation?.deductive?.length) {
    const deductive = context.representation.deductive
      .slice(0, 3)
      .map((d: any) => d.conclusion)
      .join("; ");
    parts.push(`Insights: ${deductive}`);
  }

  if (context?.peer_card?.length) {
    parts.push(`Profile: ${context.peer_card.join("; ")}`);
  }

  return parts;
}

async function fetchFreshContext(config: any, cwd: string, prompt: string): Promise<string[]> {
  const client = new Honcho({
    apiKey: config.apiKey,
    environment: "production",
  });

  // Try to use cached IDs
  let workspaceId = getCachedWorkspaceId(config.workspace);
  if (!workspaceId) {
    const workspace = await client.workspaces.getOrCreate({ id: config.workspace });
    workspaceId = workspace.id;
  }

  const userPeerId = getCachedPeerId(config.peerName);
  if (!userPeerId) {
    // Can't fetch context without peer ID
    return [];
  }

  const sessionName = getSessionName(cwd);
  let sessionId = getCachedSessionId(cwd);
  if (!sessionId) {
    const session = await client.workspaces.sessions.getOrCreate(workspaceId, { id: sessionName });
    sessionId = session.id;
  }

  const contextParts: string[] = [];

  // Parallel fetch: semantic search + dialectic
  const [contextResult, chatResult] = await Promise.allSettled([
    client.workspaces.peers.getContext(workspaceId, userPeerId, {
      search_query: prompt.slice(0, 500),
      search_top_k: 10,
      search_max_distance: 0.7,
      max_observations: 15,
      include_most_derived: true,
    }),
    client.workspaces.peers.chat(workspaceId, userPeerId, {
      query: `Based on what you know about ${config.peerName}, what context is relevant to this query: "${prompt.slice(0, 200)}"? Answer in 1-2 sentences.`,
      session_id: sessionId,
    }),
  ]);

  // Process semantic search results
  if (contextResult.status === "fulfilled" && contextResult.value) {
    const context = contextResult.value;
    setCachedEriContext(context); // Update cache

    if (context.representation?.explicit?.length) {
      const explicit = context.representation.explicit
        .slice(0, 5)
        .map((e: any) => e.content || e)
        .join("; ");
      contextParts.push(`Relevant facts: ${explicit}`);
    }

    if (context.representation?.deductive?.length) {
      const deductive = context.representation.deductive
        .slice(0, 3)
        .map((d: any) => d.conclusion)
        .join("; ");
      contextParts.push(`Insights: ${deductive}`);
    }

    if (context.peer_card?.length) {
      contextParts.push(`Profile: ${context.peer_card.join("; ")}`);
    }
  }

  // Process dialectic response
  if (chatResult.status === "fulfilled" && chatResult.value?.content) {
    contextParts.push(`Context: ${chatResult.value.content}`);
  }

  return contextParts;
}

function outputContext(peerName: string, contextParts: string[]): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `[Honcho Memory for ${peerName}]: ${contextParts.join(" | ")}`,
    },
  };
  console.log(JSON.stringify(output));
}
