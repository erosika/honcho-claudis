import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";

const CACHE_DIR = join(homedir(), ".honcho-claudis");
const ID_CACHE_FILE = join(CACHE_DIR, "cache.json");
const CONTEXT_CACHE_FILE = join(CACHE_DIR, "context-cache.json");
const MESSAGE_QUEUE_FILE = join(CACHE_DIR, "message-queue.jsonl");
const CLAUDIS_CONTEXT_FILE = join(CACHE_DIR, "claudis-context.md");

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

// ============================================
// Context Cache - eri + claudis context with TTL
// ============================================

interface ContextCache {
  eriContext?: { data: any; fetchedAt: number };
  claudisContext?: { data: any; fetchedAt: number };
  summaries?: { data: any; fetchedAt: number };
}

const CONTEXT_TTL = 60000; // 60 seconds

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

export function getCachedEriContext(): any | null {
  const cache = loadContextCache();
  if (cache.eriContext && Date.now() - cache.eriContext.fetchedAt < CONTEXT_TTL) {
    return cache.eriContext.data;
  }
  return null;
}

export function setCachedEriContext(data: any): void {
  const cache = loadContextCache();
  cache.eriContext = { data, fetchedAt: Date.now() };
  saveContextCache(cache);
}

export function getCachedClaudisContext(): any | null {
  const cache = loadContextCache();
  if (cache.claudisContext && Date.now() - cache.claudisContext.fetchedAt < CONTEXT_TTL) {
    return cache.claudisContext.data;
  }
  return null;
}

export function setCachedClaudisContext(data: any): void {
  const cache = loadContextCache();
  cache.claudisContext = { data, fetchedAt: Date.now() };
  saveContextCache(cache);
}

export function isContextCacheStale(): boolean {
  const cache = loadContextCache();
  if (!cache.eriContext) return true;
  return Date.now() - cache.eriContext.fetchedAt >= CONTEXT_TTL;
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
}

export function queueMessage(content: string, peerId: string, cwd: string): void {
  ensureCacheDir();
  const message: QueuedMessage = {
    content,
    peerId,
    cwd,
    timestamp: new Date().toISOString(),
    uploaded: false,
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
// Claudis Context File - self-summary
// ============================================

export function getClaudisContextPath(): string {
  return CLAUDIS_CONTEXT_FILE;
}

export function loadClaudisLocalContext(): string {
  ensureCacheDir();
  if (!existsSync(CLAUDIS_CONTEXT_FILE)) {
    return "";
  }
  try {
    return readFileSync(CLAUDIS_CONTEXT_FILE, "utf-8");
  } catch {
    return "";
  }
}

export function saveClaudisLocalContext(content: string): void {
  ensureCacheDir();
  writeFileSync(CLAUDIS_CONTEXT_FILE, content);
}

export function appendClaudisWork(workDescription: string): void {
  ensureCacheDir();
  const timestamp = new Date().toISOString();
  const entry = `\n- [${timestamp}] ${workDescription}`;

  let existing = loadClaudisLocalContext();
  if (!existing) {
    existing = `# Claudis Work Context\n\nAuto-generated log of claudis's recent work.\n\n## Recent Activity\n`;
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

  saveClaudisLocalContext(existing + entry);
}

export function generateClaudisSummary(
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

  let summary = `# Claudis Work Context

Last updated: ${timestamp}
Session: ${sessionName}

## What Claudis Was Working On

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
  // Don't clear claudis-context.md - that's valuable history
}
