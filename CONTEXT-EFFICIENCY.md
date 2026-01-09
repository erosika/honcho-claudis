# Context Efficiency Research

> Deep research on optimizing honcho-clawd's context management for LLM consumption.

## Implementation Status

### Completed (auto-experiments branch)

1. **Dialectic Response Caching** - `src/cache.ts`
   - 2-hour TTL for cached `peers.chat()` responses
   - Saves $0.06 per session when cache is warm
   - Functions: `getCachedUserDialectic()`, `setCachedUserDialectic()`, etc.

2. **Context Compression Module** - `src/context-format.ts`
   - Tiered context budgets: essential (~300 tokens), extended (~800), deep (~2000)
   - Compact key-value format option for 60% token reduction
   - `formatPromptContext()` for ultra-compact per-prompt injection
   - `formatMemoryAnchor()` for pre-compact PRESERVE markers
   - `deduplicateFacts()` for semantic deduplication

3. **Message Batching Utilities** - `src/cache.ts`
   - `getMessageBatches()` for efficient API uploads (up to 100 per batch)
   - `getPendingMessageCount()` for queue monitoring

4. **Configuration Extensions** - `src/config.ts`
   - `contextRefresh.tier`: "essential" | "extended" | "deep"
   - `contextRefresh.compressedFormat`: boolean
   - `contextRefresh.dialecticCacheTtlHours`: number

5. **Hook Updates**
   - `session-start.ts`: Uses dialectic caching, logs cost savings
   - `user-prompt.ts`: Uses `formatPromptContext()` for compact output

### Pending (Future Work)

- Tiered context loading in session-start hook
- Message batch upload at session-end
- A/B testing framework for context strategies

## Executive Summary

This document analyzes how honcho-clawd currently leverages Claude Code and Honcho, identifying opportunities for more efficient context representation, tokenization, and LLM-digestible formatting.

---

## Part 1: Current State Analysis

### How We Currently Leverage Claude Code

| Hook | Purpose | Latency | Context Strategy |
|------|---------|---------|------------------|
| SessionStart | Load full context | ~400ms | Output plain text markdown (2000-3000 tokens) |
| UserPromptSubmit | Per-prompt context | ~10-200ms | JSON with `additionalContext` (50-150 tokens) |
| PostToolUse | Track AI actions | ~50-200ms | No output, logs to Honcho |
| SessionEnd | Save session data | ~500-1000ms | No output, uploads messages |
| PreCompact | Memory anchor | ~500-1000ms | PRESERVE-tagged markdown block |

### How We Currently Leverage Honcho

| Feature | Endpoint | Cost | Current Usage |
|---------|----------|------|---------------|
| User Memory | `peers.getContext()` | FREE | 30 observations, all fields |
| AI Self-Awareness | `peers.getContext()` | FREE | 20 observations, all fields |
| Session Summaries | `sessions.summaries()` | FREE | Both short and long |
| Dialectic Chat | `peers.chat()` | $0.03/call | 2x per session start |
| Message Upload | `messages.create()` | ~$0.001 | 1 call per message |

### Token Budget Analysis

**Current SessionStart Output:**
```
Header (identity, git)     ~100 tokens
Feature context            ~50 tokens
Git changes                ~30 tokens
Local clawd context        ~300 tokens (capped 2000 chars)
User profile               ~80 tokens
User facts (15)            ~200 tokens
User insights (10)         ~150 tokens
AI work history            ~150 tokens
AI insights                ~100 tokens
Short summary              ~100 tokens
Long summary               ~400 tokens
User dialectic             ~150 tokens
AI dialectic               ~150 tokens
─────────────────────────────────────
TOTAL                      ~1960 tokens
```

### Identified Inefficiencies

1. **Redundant User Profile** (3 sources):
   - `peer_card[]` (profile facts)
   - `representation.explicit[]` (extracted facts)
   - `peers.chat()` response (LLM synthesis)
   → Same information, 3x token cost

2. **Verbose Markdown Headers**:
   - `## What I Know About eri` (26 chars + newlines)
   - Could be `[eri/facts]` (11 chars)

3. **Expensive Dialectic Calls**:
   - $0.06 per session (2 x $0.03)
   - Often redundant with structured context
   - Not cached between sessions

4. **Non-Batched Message Uploads**:
   - 1 API call per user message
   - Could batch 10-20 per call

5. **Full Field Caching**:
   - Cache stores entire API responses
   - Only ~30% of fields actually used

---

## Part 2: Honcho API Optimization Opportunities

### Token Allocation Strategy

Honcho's `get_context()` allocates tokens: **40% summaries, 60% recent messages**.

**Recommendation**: Leverage this for our context building:
```typescript
// Request specific token budget
const context = await peers.getContext(workspaceId, peerId, {
  max_tokens: 500,  // Let Honcho optimize allocation
  summary_ratio: 0.4,  // Use default 40% for summary
});
```

### Batch Message Creation

**Current**: 1 API call per message
```typescript
// Current: N API calls
for (const msg of messages) {
  await messages.create(..., { messages: [msg] });
}
```

**Optimal**: Batch up to 100 per call
```typescript
// Optimal: 1 API call
await messages.create(..., { messages: messages.slice(0, 100) });
```

**Savings**: 90%+ reduction in API calls

### Working Representation Scoping

Honcho supports scoped representations:
- **Session-specific**: Only facts relevant to current session
- **Omniscient**: All accumulated knowledge
- **Observer perspective**: From specific peer's viewpoint

**Current**: Omniscient (all facts)
**Optimal**: Session-scoped for UserPromptSubmit, omniscient for SessionStart

---

## Part 3: Context Compression Strategies

### Strategy 1: Hierarchical Context Tiers

Instead of loading everything at SessionStart, use tiered loading:

**Tier 1 (Essential, ~200 tokens)**:
- User identity + git state
- Top 3 user facts
- Current session summary

**Tier 2 (Extended, ~500 tokens)**:
- Full user representation
- AI work history
- Long summary

**Tier 3 (Deep, ~1500 tokens)**:
- Dialectic responses
- All observations
- Extended history

**Implementation**:
```typescript
type ContextTier = "essential" | "extended" | "deep";

function getContextForTier(tier: ContextTier): string {
  switch (tier) {
    case "essential": return buildEssentialContext();
    case "extended": return buildExtendedContext();
    case "deep": return buildDeepContext();
  }
}
```

### Strategy 2: Compressed Markdown Format

**Current verbose format**:
```markdown
## What I Know About eri

### Explicit Facts
- eri prefers TypeScript over JavaScript
- eri uses Vim keybindings
- eri is working on honcho-clawd

### Deduced Insights
- eri is focused on developer tools (from: recent projects)
```

**Compressed format**:
```markdown
[eri/memory]
facts: TypeScript>JS; Vim keybindings; working on honcho-clawd
insights: focused on dev tools (recent projects)
```

**Token savings**: ~60% reduction

### Strategy 3: Structured Data Blocks

Instead of prose, use structured blocks LLMs parse efficiently:

```yaml
---context: user/eri---
facts:
  - TypeScript preference
  - Vim keybindings
  - honcho-clawd focus
insights:
  - dev tools focus
profile: Software engineer, CLI tools
---end---
```

LLMs are trained on structured data and parse it efficiently.

### Strategy 4: Semantic Deduplication

Before outputting, deduplicate semantically similar facts:

```typescript
function deduplicateFacts(facts: string[]): string[] {
  // Group similar facts
  // Keep most specific version
  // Remove redundant generalizations
}
```

---

## Part 4: LLM-Digestible Markdown Patterns

### Pattern 1: Hierarchical Headers for Scannability

LLMs process hierarchical structure efficiently:

```markdown
# Session: honcho-clawd
## User: eri
- facts: [compact list]
- insights: [compact list]
## AI: clawd
- recent: [work items]
## Context
- branch: auto-experiments
- focus: context efficiency
```

### Pattern 2: Key-Value Density

Dense key-value pairs > verbose prose:

```markdown
user=eri | ai=clawd | ws=claude-code | branch=auto-experiments
facts: prefers TypeScript; uses Vim; focused on efficiency
work: context compression; tokenization research
```

### Pattern 3: Reference Markers

Use short reference markers for repeated concepts:

```markdown
[U] = eri (user)
[A] = clawd (AI)
[S] = honcho-clawd (session)

[U] facts: TypeScript, Vim
[A] recent: edited cache.ts, researched Honcho API
[S] focus: context efficiency
```

### Pattern 4: Priority Ordering

Most important information first (LLM attention is front-weighted):

```markdown
## Priority Context
CURRENT: Working on context efficiency for honcho-clawd
BRANCH: auto-experiments
FOCUS: tokenization, LLM-digestible markdown

## Background (less critical)
...
```

---

## Part 5: Implementation Recommendations

### Immediate Wins (Low Effort, High Impact)

1. **Deduplicate User Profile** (~30% savings)
   - Remove dialectic if structured context is rich
   - Or skip structured context if dialectic is comprehensive

2. **Compress Markdown Format** (~40% savings)
   - Use compact key-value notation
   - Remove verbose headers

3. **Cache Dialectic Responses** (~$0.05/session savings)
   - TTL of 1-2 hours
   - Only refresh if substantial new data

### Medium-Term Improvements

4. **Tiered Context Loading**
   - Essential tier for most prompts
   - Deep tier only when needed

5. **Batch Message Uploads**
   - Collect messages in queue
   - Upload batch at session end or every 10 messages

6. **Session-Scoped Context for UserPrompt**
   - Use `limit_to_session: true` for per-prompt context
   - Omniscient only at session start

### Long-Term Architecture

7. **Adaptive Context Selection**
   - Analyze prompt to determine needed context
   - Load only relevant sections

8. **Context Streaming**
   - Stream context as sections become available
   - Don't wait for all 5 parallel fetches

9. **Semantic Caching**
   - Cache context by semantic similarity
   - Reuse context for similar prompts

---

## Part 6: Metrics & Measurement

### Key Metrics to Track

| Metric | Current | Target |
|--------|---------|--------|
| SessionStart tokens | ~2000 | ~800 |
| SessionStart latency | ~400ms | ~200ms |
| UserPrompt tokens | ~100 | ~50 |
| UserPrompt latency | ~50ms | ~20ms |
| Dialectic cost/session | $0.06 | $0.01 |
| API calls/message | 1 | 0.1 |

### A/B Testing Framework

```typescript
const EXPERIMENT_FLAGS = {
  compressedMarkdown: true,
  tieredContext: true,
  dialecticCaching: true,
  batchMessages: true,
};

function buildContext(flags: typeof EXPERIMENT_FLAGS): string {
  // Build context based on enabled flags
  // Log metrics for comparison
}
```

---

## Appendix A: Honcho API Reference

### Key Endpoints for Context

```typescript
// Get pre-computed context (FREE)
peers.getContext(workspaceId, peerId, {
  max_observations: 30,
  include_most_derived: true,
  search_query: "optional semantic filter",
  search_top_k: 10,
});

// Get session-specific context (FREE)
sessions.getContext(workspaceId, sessionId, {
  limit_to_session: true,
  max_tokens: 500,
});

// Dialectic query ($0.03)
peers.chat(workspaceId, peerId, {
  query: "What matters most about this user?",
  session_id: sessionId,
});

// Batch message upload
messages.create(workspaceId, sessionId, {
  messages: [
    { content: "msg1", peer_id: "eri" },
    { content: "msg2", peer_id: "eri" },
    // ... up to 100
  ],
});
```

### Token Allocation

Honcho's automatic allocation: **40% summaries, 60% recent messages**

Can override with explicit parameters for fine-grained control.

---

## Appendix B: Claude Code Hook Contracts

### SessionStart Output

```typescript
// Plain text → injected into system prompt
console.log("Context here...");
process.exit(0);

// OR JSON with additionalContext
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: "Context here..."
  }
}));
```

### UserPromptSubmit Output

```typescript
// JSON with additionalContext (per-prompt injection)
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "[Memory]: facts here..."
  }
}));
```

### PreCompact Output

```typescript
// Plain text with PRESERVE markers
console.log(`
## MEMORY ANCHOR (PRESERVE)
Critical facts that must survive compaction...
## END ANCHOR
`);
```

---

*Research compiled: January 2026*
*Branch: auto-experiments*
