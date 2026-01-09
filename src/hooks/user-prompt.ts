import Honcho from "@honcho-ai/core";
import { loadConfig, getSessionForPath, getHonchoClientOptions } from "../config.js";
import { basename } from "path";
import {
  getCachedWorkspaceId,
  setCachedWorkspaceId,
  getCachedPeerId,
  getCachedSessionId,
  setCachedSessionId,
  getCachedUserContext,
  isContextCacheStale,
  setCachedUserContext,
  queueMessage,
  incrementMessageCount,
  shouldRefreshKnowledgeGraph,
  markKnowledgeGraphRefreshed,
  getClaudeInstanceId,
} from "../cache.js";
import { formatPromptContext, type UserContext } from "../context-format.js";
import { logHook, logApiCall, logCache, logFlow, setLogContext } from "../log.js";

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
  return basename(cwd).toLowerCase().replace(/[^a-z0-9-_]/g, "-");
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

  // Set log context for this hook
  setLogContext(cwd, getSessionName(cwd));

  // Skip empty prompts
  if (!prompt.trim()) {
    process.exit(0);
  }

  logHook("user-prompt", `Prompt received (${prompt.length} chars)`);

  // CRITICAL: Save message to local queue FIRST (instant, ~1-3ms)
  // This survives ctrl+c, network failures, everything
  if (config.saveMessages !== false) {
    queueMessage(prompt, config.peerName, cwd);
  }

  // Start upload immediately (we'll await before exit)
  let uploadPromise: Promise<void> | null = null;
  if (config.saveMessages !== false) {
    uploadPromise = uploadMessageAsync(config, cwd, prompt);
  }

  // Track message count for threshold-based knowledge graph refresh
  const messageCount = incrementMessageCount();

  // For trivial prompts, skip heavy context retrieval but still upload
  if (shouldSkipContextRetrieval(prompt)) {
    logHook("user-prompt", "Skipping context (trivial prompt)");
    if (uploadPromise) await uploadPromise.catch(() => {});
    process.exit(0);
  }

  // Determine if we should refresh: either cache is stale OR message threshold reached
  const forceRefresh = shouldRefreshKnowledgeGraph();
  const cachedContext = getCachedUserContext();
  const cacheIsStale = isContextCacheStale();

  if (cachedContext && !cacheIsStale && !forceRefresh) {
    // Use cached context - instant response
    logCache("hit", "userContext", "using cached");
    const contextStr = formatCachedContext(cachedContext, config.peerName);
    if (contextStr) {
      outputContextString(contextStr);
    }
    if (uploadPromise) await uploadPromise.catch(() => {});
    process.exit(0);
  }

  // Fetch fresh context when:
  // 1. Cache is stale (>60s old), OR
  // 2. Message threshold reached (every 10 messages)
  logCache("miss", "userContext", forceRefresh ? "threshold refresh" : "stale cache");
  try {
    const contextStr = await fetchFreshContext(config, cwd, prompt);
    if (contextStr) {
      outputContextString(contextStr);
    }
    // Mark that we refreshed the knowledge graph
    if (forceRefresh) {
      markKnowledgeGraphRefreshed();
    }
  } catch {
    // Context fetch failed, continue without
  }

  // Ensure upload completes before exit
  if (uploadPromise) await uploadPromise.catch(() => {});
  process.exit(0);
}

async function uploadMessageAsync(config: any, cwd: string, prompt: string): Promise<void> {
  logApiCall("sessions.messages.create", "POST", `user prompt (${prompt.length} chars)`);
  const client = new Honcho(getHonchoClientOptions(config));

  // Try to use cached IDs for speed
  let workspaceId = getCachedWorkspaceId(config.workspace);
  let sessionId = getCachedSessionId(cwd);

  if (!workspaceId || !sessionId) {
    // No cache - need full setup and cache the results
    const workspace = await client.workspaces.getOrCreate({ id: config.workspace });
    workspaceId = workspace.id;
    setCachedWorkspaceId(config.workspace, workspaceId);

    const sessionName = getSessionName(cwd);
    const session = await client.workspaces.sessions.getOrCreate(workspaceId, {
      id: sessionName,
      metadata: { cwd },
    });
    sessionId = session.id;
    setCachedSessionId(cwd, sessionName, sessionId);
  }

  // Include instance_id in metadata for parallel session support
  const instanceId = getClaudeInstanceId();
  await client.workspaces.sessions.messages.create(workspaceId, sessionId, {
    messages: [{
      content: prompt,
      peer_id: config.peerName,
      metadata: instanceId ? { instance_id: instanceId } : undefined,
    }],
  });
}

/**
 * Format cached context using the new compact format
 */
function formatCachedContext(context: any, peerName: string): string {
  // Convert API response to UserContext type
  const userContext: UserContext = {
    peerCard: context?.peer_card,
    explicit: context?.representation?.explicit?.map((e: any) => ({
      content: typeof e === "string" ? e : e.content,
    })),
    deductive: context?.representation?.deductive?.map((d: any) => ({
      conclusion: d.conclusion,
      premises: d.premises,
    })),
  };

  return formatPromptContext(peerName, userContext);
}

async function fetchFreshContext(config: any, cwd: string, prompt: string): Promise<string> {
  const client = new Honcho(getHonchoClientOptions(config));

  // Try to use cached IDs
  let workspaceId = getCachedWorkspaceId(config.workspace);
  if (!workspaceId) {
    const workspace = await client.workspaces.getOrCreate({ id: config.workspace });
    workspaceId = workspace.id;
  }

  const userPeerId = getCachedPeerId(config.peerName);
  if (!userPeerId) {
    // Can't fetch context without peer ID
    return "";
  }

  const sessionName = getSessionName(cwd);
  let sessionId = getCachedSessionId(cwd);
  if (!sessionId) {
    const session = await client.workspaces.sessions.getOrCreate(workspaceId, { id: sessionName });
    sessionId = session.id;
  }

  // Only use getContext() here - it's free/cheap and returns pre-computed knowledge
  // Skip chat() ($0.03 per call) - only use at session-start
  const startTime = Date.now();
  const contextResult = await client.workspaces.peers.getContext(workspaceId, userPeerId, {
    search_query: prompt.slice(0, 500),
    search_top_k: 10,
    search_max_distance: 0.7,
    max_observations: 15,
    include_most_derived: true,
  });

  logApiCall("peers.getContext", "GET", `search query`, Date.now() - startTime, true);

  if (contextResult) {
    setCachedUserContext(contextResult); // Update cache
    logCache("write", "userContext", `${contextResult.representation?.explicit?.length || 0} facts`);
    return formatCachedContext(contextResult, config.peerName);
  }

  return "";
}

/**
 * Output context string in Claude Code hook format
 */
function outputContextString(contextStr: string): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: contextStr,
    },
  };
  console.log(JSON.stringify(output));
}
