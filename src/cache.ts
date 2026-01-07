import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { getContextRefreshConfig } from "./config.js";

const CACHE_DIR = join(homedir(), ".honcho-clawd");
const ID_CACHE_FILE = join(CACHE_DIR, "cache.json");
const CONTEXT_CACHE_FILE = join(CACHE_DIR, "context-cache.json");
const MESSAGE_QUEUE_FILE = join(CACHE_DIR, "message-queue.jsonl");
const CLAWD_CONTEXT_FILE = join(CACHE_DIR, "clawd-context.md");

// Ensure cache directory exists
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// ============================================
// ID Cache - workspace, session, peer IDs
// ============================================

interface IdCache {
  workspace?: { name: string; id: string };
  peers?: Record<string, string>; // peerName -> peerId
  sessions?: Record<string, { name: string; id: string; updatedAt: string }>; // cwd -> session info
  claudeInstanceId?: string; // Current Claude Code session_id for instance tagging
}

export function loadIdCache(): IdCache {
  ensureCacheDir();
  if (!existsSync(ID_CACHE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(ID_CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveIdCache(cache: IdCache): void {
  ensureCacheDir();
  writeFileSync(ID_CACHE_FILE, JSON.stringify(cache, null, 2));
}

export function getCachedWorkspaceId(workspaceName: string): string | null {
  const cache = loadIdCache();
  if (cache.workspace?.name === workspaceName) {
    return cache.workspace.id;
  }
  return null;
}

export function setCachedWorkspaceId(name: string, id: string): void {
  const cache = loadIdCache();
  cache.workspace = { name, id };
  saveIdCache(cache);
}

export function getCachedPeerId(peerName: string): string | null {
  const cache = loadIdCache();
  return cache.peers?.[peerName] || null;
}

export function setCachedPeerId(peerName: string, peerId: string): void {
  const cache = loadIdCache();
  if (!cache.peers) cache.peers = {};
  cache.peers[peerName] = peerId;
  saveIdCache(cache);
}

export function getCachedSessionId(cwd: string): string | null {
  const cache = loadIdCache();
  return cache.sessions?.[cwd]?.id || null;
}

export function setCachedSessionId(cwd: string, name: string, id: string): void {
  const cache = loadIdCache();
  if (!cache.sessions) cache.sessions = {};
  cache.sessions[cwd] = { name, id, updatedAt: new Date().toISOString() };
  saveIdCache(cache);
}

// Claude instance tracking for parallel session support
export function getClaudeInstanceId(): string | null {
  const cache = loadIdCache();
  return cache.claudeInstanceId || null;
}

export function setClaudeInstanceId(instanceId: string): void {
  const cache = loadIdCache();
  cache.claudeInstanceId = instanceId;
  saveIdCache(cache);
}

// ============================================
// Context Cache - user + clawd context with TTL
// ============================================

interface ContextCache {
  userContext?: { data: any; fetchedAt: number };
  clawdContext?: { data: any; fetchedAt: number };
  summaries?: { data: any; fetchedAt: number };
  messageCount?: number; // Track messages since last refresh
  lastRefreshMessageCount?: number; // Message count at last knowledge graph refresh
}

// These are now configurable via config.json, with defaults in getContextRefreshConfig()
function getContextTTL(): number {
  const config = getContextRefreshConfig();
  return (config.ttlSeconds ?? 300) * 1000; // Convert to ms
}

function getMessageRefreshThreshold(): number {
  const config = getContextRefreshConfig();
  return config.messageThreshold ?? 50;
}

export function loadContextCache(): ContextCache {
  ensureCacheDir();
  if (!existsSync(CONTEXT_CACHE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(CONTEXT_CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveContextCache(cache: ContextCache): void {
  ensureCacheDir();
  writeFileSync(CONTEXT_CACHE_FILE, JSON.stringify(cache, null, 2));
}

export function getCachedUserContext(): any | null {
  const cache = loadContextCache();
  if (cache.userContext && Date.now() - cache.userContext.fetchedAt < getContextTTL()) {
    return cache.userContext.data;
  }
  return null;
}

export function setCachedUserContext(data: any): void {
  const cache = loadContextCache();
  cache.userContext = { data, fetchedAt: Date.now() };
  saveContextCache(cache);
}

export function getCachedClawdContext(): any | null {
  const cache = loadContextCache();
  if (cache.clawdContext && Date.now() - cache.clawdContext.fetchedAt < getContextTTL()) {
    return cache.clawdContext.data;
  }
  return null;
}

export function setCachedClawdContext(data: any): void {
  const cache = loadContextCache();
  cache.clawdContext = { data, fetchedAt: Date.now() };
  saveContextCache(cache);
}

export function isContextCacheStale(): boolean {
  const cache = loadContextCache();
  if (!cache.userContext) return true;
  return Date.now() - cache.userContext.fetchedAt >= getContextTTL();
}

// Track message count for threshold-based refresh
export function incrementMessageCount(): number {
  const cache = loadContextCache();
  cache.messageCount = (cache.messageCount || 0) + 1;
  saveContextCache(cache);
  return cache.messageCount;
}

export function shouldRefreshKnowledgeGraph(): boolean {
  const cache = loadContextCache();
  const currentCount = cache.messageCount || 0;
  const lastRefresh = cache.lastRefreshMessageCount || 0;

  // Refresh if we've sent threshold messages since last refresh
  return (currentCount - lastRefresh) >= getMessageRefreshThreshold();
}

export function markKnowledgeGraphRefreshed(): void {
  const cache = loadContextCache();
  cache.lastRefreshMessageCount = cache.messageCount || 0;
  saveContextCache(cache);
}

export function resetMessageCount(): void {
  const cache = loadContextCache();
  cache.messageCount = 0;
  cache.lastRefreshMessageCount = 0;
  saveContextCache(cache);
}

// ============================================
// Message Queue - local file for reliability
// ============================================

interface QueuedMessage {
  content: string;
  peerId: string;
  cwd: string;
  timestamp: string;
  uploaded?: boolean;
  instanceId?: string; // Claude Code instance for parallel session support
}

export function queueMessage(content: string, peerId: string, cwd: string, instanceId?: string): void {
  ensureCacheDir();
  const message: QueuedMessage = {
    content,
    peerId,
    cwd,
    timestamp: new Date().toISOString(),
    uploaded: false,
    instanceId: instanceId || getClaudeInstanceId() || undefined,
  };
  appendFileSync(MESSAGE_QUEUE_FILE, JSON.stringify(message) + "\n");
}

export function getQueuedMessages(): QueuedMessage[] {
  ensureCacheDir();
  if (!existsSync(MESSAGE_QUEUE_FILE)) {
    return [];
  }
  try {
    const content = readFileSync(MESSAGE_QUEUE_FILE, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    return lines.map((line) => JSON.parse(line)).filter((msg) => !msg.uploaded);
  } catch {
    return [];
  }
}

export function clearMessageQueue(): void {
  ensureCacheDir();
  writeFileSync(MESSAGE_QUEUE_FILE, "");
}

export function markMessagesUploaded(): void {
  // Simply clear the queue after successful upload
  clearMessageQueue();
}

// ============================================
// CLAWD Context File - self-summary
// ============================================

export function getClawdContextPath(): string {
  return CLAWD_CONTEXT_FILE;
}

export function loadClawdLocalContext(): string {
  ensureCacheDir();
  if (!existsSync(CLAWD_CONTEXT_FILE)) {
    return "";
  }
  try {
    return readFileSync(CLAWD_CONTEXT_FILE, "utf-8");
  } catch {
    return "";
  }
}

export function saveClawdLocalContext(content: string): void {
  ensureCacheDir();
  writeFileSync(CLAWD_CONTEXT_FILE, content);
}

export function appendClawdWork(workDescription: string): void {
  ensureCacheDir();
  const timestamp = new Date().toISOString();
  const entry = `\n- [${timestamp}] ${workDescription}`;

  let existing = loadClawdLocalContext();
  if (!existing) {
    existing = `# CLAWD Work Context\n\nAuto-generated log of CLAWD's recent work.\n\n## Recent Activity\n`;
  }

  // Keep only last 50 entries to prevent file from growing too large
  const lines = existing.split("\n");
  const activityStart = lines.findIndex((l) => l.includes("## Recent Activity"));
  if (activityStart !== -1) {
    const header = lines.slice(0, activityStart + 1);
    const activities = lines.slice(activityStart + 1).filter((l) => l.trim());
    const recentActivities = activities.slice(-49); // Keep last 49, add 1 new
    existing = [...header, ...recentActivities].join("\n");
  }

  saveClawdLocalContext(existing + entry);
}

export function generateClawdSummary(
  sessionName: string,
  workItems: string[],
  assistantMessages: string[]
): string {
  const timestamp = new Date().toISOString();

  // Extract key actions from assistant messages
  const actions: string[] = [];
  for (const msg of assistantMessages.slice(-10)) {
    // Look for action indicators
    if (msg.includes("Created") || msg.includes("Updated") || msg.includes("Fixed")) {
      const firstSentence = msg.split(/[.!?\n]/)[0];
      if (firstSentence.length < 200) {
        actions.push(firstSentence);
      }
    }
  }

  let summary = `# CLAWD Work Context

Last updated: ${timestamp}
Session: ${sessionName}

## What CLAWD Was Working On

`;

  if (workItems.length > 0) {
    summary += workItems.map((w) => `- ${w}`).join("\n");
    summary += "\n\n";
  }

  if (actions.length > 0) {
    summary += "## Recent Actions\n\n";
    summary += actions.slice(-10).map((a) => `- ${a}`).join("\n");
    summary += "\n\n";
  }

  summary += "## Recent Activity\n";

  return summary;
}

// ============================================
// Utility: Clear all caches (for debugging)
// ============================================

export function clearAllCaches(): void {
  ensureCacheDir();
  if (existsSync(ID_CACHE_FILE)) writeFileSync(ID_CACHE_FILE, "{}");
  if (existsSync(CONTEXT_CACHE_FILE)) writeFileSync(CONTEXT_CACHE_FILE, "{}");
  if (existsSync(MESSAGE_QUEUE_FILE)) writeFileSync(MESSAGE_QUEUE_FILE, "");
  // Don't clear clawd-context.md - that's valuable history
}
