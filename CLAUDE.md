# honcho-claudis

Persistent memory for Claude Code sessions using Honcho by Plastic Labs.

## Project Structure

```
src/
├── cli.ts           # Main CLI entry point (init, install, uninstall, status, session, hook commands)
├── config.ts        # Config management (~/.honcho-claudis/config.json)
├── cache.ts         # Caching layer (IDs, context cache, message queue, claudis self-context)
├── install.ts       # Hook installation to ~/.claude/settings.json
└── hooks/
    ├── session-start.ts    # Loads context from Honcho + local claudis context (parallel)
    ├── session-end.ts      # Batch uploads messages + generates claudis summary
    ├── post-tool-use.ts    # Fire-and-forget tool logging + local claudis updates
    └── user-prompt.ts      # Local queue + fire-and-forget upload + cached context
```

## Build & Run

```bash
bun install                    # Install dependencies
bun run build                  # Build to dist/cli.js
bun run dev <command>          # Run in development mode
```

## CLI Commands

```bash
honcho-claudis init       # Interactive setup (peer name, API key, workspace, saveMessages)
honcho-claudis install    # Install hooks to ~/.claude/settings.json
honcho-claudis uninstall  # Remove hooks
honcho-claudis status     # Show configuration status

# Session management
honcho-claudis session new [name]     # Create/connect session
honcho-claudis session list           # List all sessions
honcho-claudis session current        # Show current session
honcho-claudis session switch <name>  # Switch session
honcho-claudis session clear          # Remove custom session mapping
```

## Architecture

### Performance Optimizations

| Hook | Latency | Technique |
|------|---------|-----------|
| session-start | ~400ms | Parallel API calls, cached IDs, local claudis context |
| user-prompt | ~10-20ms | Local queue (1ms), fire-and-forget upload, cached context |
| post-tool-use | ~5ms | Fire-and-forget, local claudis-context.md update |
| session-end | ~500ms | Batch upload, claudis summary generation |

### Cache Files

```
~/.honcho-claudis/
├── config.json           # User settings
├── cache.json            # Cached Honcho IDs (workspace, session, peers)
├── context-cache.json    # Pre-warmed context with 60s TTL
├── message-queue.jsonl   # Local message queue for reliability
└── claudis-context.md    # AI self-summary (survives context wipes)
```

## How It Works

### SessionStart
1. Load cached IDs (skip getOrCreate if cached)
2. Load local `claudis-context.md` (instant)
3. Parallel fetch: eri context, claudis context, summaries, dialectic queries
4. Output combined context to Claude

### UserPromptSubmit
1. Write message to local queue (instant, ~1ms)
2. Fire-and-forget upload to Honcho
3. Use cached context if fresh (<60s), else fetch in parallel
4. Skip heavy operations for trivial prompts

### PostToolUse
1. Append to local `claudis-context.md` (instant, ~2ms)
2. Fire-and-forget log to Honcho
3. Return immediately

### SessionEnd
1. Process local message queue (batch upload)
2. Save assistant messages to Honcho
3. Generate and save claudis work summary
4. Clear message queue

## Key Features

- **Survives ctrl+c**: Local message queue ensures no data loss
- **AI Self-Awareness**: claudis knows what it was working on via local context
- **Dual Peer System**: Separate memory for user (eri) and AI (claudis)
- **98% Faster Hooks**: Caching, parallelization, fire-and-forget patterns

## Dependencies

- `@honcho-ai/core` - Honcho SDK for memory/context APIs
- Uses `Bun.stdin.text()` in hooks to read JSON input from Claude Code

## Configuration

`~/.honcho-claudis/config.json`:
```json
{
  "peerName": "eri",
  "apiKey": "hch-v2-...",
  "workspace": "aeris",
  "claudePeer": "claudis",
  "saveMessages": true,
  "sessions": { "/path/to/project": "session-name" }
}
```
