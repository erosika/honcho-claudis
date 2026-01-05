# honcho-claudis

**Persistent memory for Claude Code sessions using [Honcho](https://honcho.dev) by Plastic Labs.**

Give Claude Code long-term memory that survives context wipes, session restarts, and even `ctrl+c` interruptions. Built on Honcho's Theory of Mind (ToM) framework for rich, semantic understanding.

## Features

- **Persistent Memory**: User messages and AI responses are saved to Honcho, building long-term context
- **Survives Interruptions**: Local message queue ensures no data loss on `ctrl+c` or crashes
- **AI Self-Awareness**: Claude knows what it was working on, even after context is wiped
- **Semantic Search**: Relevant context is retrieved based on your current prompt
- **Dual Peer System**: Separate memory for user (you) and AI (claudis) with Theory of Mind
- **Ultra-Fast Hooks**: 98% latency reduction through caching, parallelization, and fire-and-forget patterns
- **Per-Directory Sessions**: Each project directory maintains its own conversation history

## Architecture

```
~/.honcho-claudis/
├── config.json           # User settings (API key, workspace, peer names)
├── cache.json            # Cached Honcho IDs (workspace, session, peers)
├── context-cache.json    # Pre-warmed context for fast retrieval
├── message-queue.jsonl   # Local message queue (reliability layer)
└── claudis-context.md    # AI self-summary (what claudis was working on)
```

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code                               │
├─────────────────────────────────────────────────────────────────┤
│  SessionStart     │  UserPrompt      │  PostToolUse  │ SessionEnd│
│  ─────────────    │  ───────────     │  ────────────  │ ──────── │
│  Load context     │  Queue message   │  Log tool use  │ Batch    │
│  from Honcho +    │  locally (1ms)   │  locally (2ms) │ upload   │
│  local claudis    │  Fire-and-forget │  Fire-and-     │ messages │
│  summary          │  upload          │  forget upload │ Generate │
│                   │  Cached context  │                │ summary  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Honcho API                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │Workspace │  │ Session  │  │    Peers     │  │  Messages   │ │
│  │ (aeris)  │──│(project) │──│ eri/claudis  │──│ (history)   │ │
│  └──────────┘  └──────────┘  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/code) CLI
- [Honcho](https://honcho.dev) account and API key

### Install from Source

```bash
# Clone the repository
git clone https://github.com/anthropics/honcho-claudis.git
cd honcho-claudis

# Install dependencies
bun install

# Build
bun run build

# Install globally
bun install -g .
```

### Setup

```bash
# Run interactive setup
honcho-claudis init
```

You'll be prompted for:
- **Your name/peer ID**: How Honcho identifies you (e.g., "eri")
- **Workspace name**: Your Honcho workspace (e.g., "myworkspace")
- **Claude's peer name**: AI identity in Honcho (default: "claudis")
- **Enable message saving**: Whether to save conversation history
- **Honcho API key**: Get from https://app.honcho.dev

### Install Hooks

```bash
# Install hooks to Claude Code
honcho-claudis install
```

This adds hooks to `~/.claude/settings.json` that activate on:
- `SessionStart`: Load memory context
- `UserPromptSubmit`: Save messages + retrieve relevant context
- `PostToolUse`: Log significant tool usage (Write, Edit, Bash, Task)
- `SessionEnd`: Save assistant messages + generate summary

## Usage

### Basic Usage

Just use Claude Code normally! Memory is automatic:

```bash
# Start Claude Code in any directory
claude

# Your conversations are automatically saved and context is retrieved
```

### Session Management

```bash
# Create/connect to a named session
honcho-claudis session new myproject

# List all sessions
honcho-claudis session list

# Show current session
honcho-claudis session current

# Switch to a different session
honcho-claudis session switch other-project

# Clear custom session (revert to default)
honcho-claudis session clear
```

### Check Status

```bash
honcho-claudis status
```

Shows:
- Configuration details
- Hook installation status
- Current session info

## Configuration

### Config File

Located at `~/.honcho-claudis/config.json`:

```json
{
  "peerName": "eri",
  "apiKey": "hch-v2-...",
  "workspace": "myworkspace",
  "claudePeer": "claudis",
  "saveMessages": true,
  "sessions": {
    "/path/to/project": "project-name"
  }
}
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `peerName` | Your identity in Honcho | (required) |
| `apiKey` | Honcho API key | (required) |
| `workspace` | Honcho workspace name | `"collab"` |
| `claudePeer` | AI identity in Honcho | `"claudis"` |
| `saveMessages` | Save conversation history | `true` |
| `sessions` | Directory → session mappings | `{}` |

## Performance

### Optimizations

The hooks are designed for minimal latency:

| Hook | Before | After | Improvement |
|------|--------|-------|-------------|
| SessionStart | 2-3s | 300-500ms | **80% faster** |
| UserPromptSubmit | 1-2s | 10-20ms | **98% faster** |
| PostToolUse | 500ms | 5-10ms | **98% faster** |
| SessionEnd | 1s | 500ms | **50% faster** |

### Key Techniques

1. **Local Message Queue**: Messages are written to a local file instantly (~1ms), then uploaded in background
2. **ID Caching**: Workspace, session, and peer IDs are cached locally to skip redundant API calls
3. **Context Caching**: Retrieved context is cached with 60s TTL for instant reuse
4. **Parallel API Calls**: All context fetches happen in parallel using `Promise.allSettled`
5. **Fire-and-Forget**: Non-critical operations don't block the user
6. **Conditional Execution**: Trivial prompts skip heavy context retrieval

## AI Self-Awareness

One unique feature is **claudis self-context**: Claude maintains awareness of its own work history, independent of Claude Code's context window.

### How It Works

1. **PostToolUse**: Every significant action (file writes, edits, commands) is logged to `~/.honcho-claudis/claudis-context.md`
2. **SessionEnd**: A summary of Claude's work is generated and saved
3. **SessionStart**: Claude receives both:
   - **Local context**: Instant read from `claudis-context.md`
   - **Honcho context**: AI's observations and patterns from the Honcho API

### Why It Matters

Claude Code's context can be wiped or compacted at any time. With honcho-claudis:

- Claude knows what it was working on before the wipe
- Claude can continue where it left off
- Claude has self-reflection: "What have I been doing recently?"

## Reliability

### Message Persistence

Messages are saved through multiple layers:

1. **Instant Local Write**: Every user message is immediately written to `message-queue.jsonl`
2. **Background Upload**: Messages are asynchronously uploaded to Honcho
3. **Batch Reconciliation**: Any missed uploads are batch-processed on session end

### Failure Scenarios

| Scenario | Data Loss? | Recovery |
|----------|------------|----------|
| `ctrl+c` exit | No | Local queue preserved, uploaded next session |
| Network failure | No | Local queue + retry on reconnection |
| Claude context wipe | No | Context restored from Honcho + local files |
| Honcho API down | Partial | Local queue preserves user messages |

## CLI Reference

```bash
honcho-claudis <command>

Commands:
  init        Configure honcho-claudis (name, API key, workspace)
  install     Install hooks to ~/.claude/settings.json
  uninstall   Remove hooks from Claude settings
  status      Show current configuration and hook status
  help        Show help message

Session Commands:
  session new [name]     Create/connect Honcho session (defaults to dir name)
  session list           List all sessions
  session current        Show current session info
  session switch <name>  Switch to existing session
  session clear          Remove custom session mapping

Hook Commands (internal):
  hook session-start    Handle SessionStart event
  hook session-end      Handle SessionEnd event
  hook post-tool-use    Handle PostToolUse event
  hook user-prompt      Handle UserPromptSubmit event
```

## Troubleshooting

### Hooks Not Working

1. Check hooks are installed:
   ```bash
   honcho-claudis status
   ```

2. Verify `~/.claude/settings.json` contains honcho-claudis hooks

3. Check for shell alias conflicts:
   ```bash
   which honcho-claudis
   type honcho-claudis
   ```

### Slow Performance

1. Clear stale caches:
   ```bash
   rm ~/.honcho-claudis/cache.json
   rm ~/.honcho-claudis/context-cache.json
   ```

2. The first request after cache clear will be slower (populating cache)

### No Context Loading

1. Verify API key is valid in `~/.honcho-claudis/config.json`
2. Check Honcho dashboard for your workspace/session
3. Ensure `saveMessages` is `true` in config

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev <command>

# Build
bun run build

# The built CLI is at dist/cli.js
```

### Project Structure

```
src/
├── cli.ts              # Main CLI entry point
├── config.ts           # Config management
├── cache.ts            # Caching layer (IDs, context, message queue)
├── install.ts          # Hook installation
└── hooks/
    ├── session-start.ts    # Load context from Honcho + local
    ├── session-end.ts      # Save messages + generate summary
    ├── post-tool-use.ts    # Log tool usage + update local context
    └── user-prompt.ts      # Queue message + retrieve context
```

## Credits

- [Honcho](https://honcho.dev) by [Plastic Labs](https://plasticlabs.ai) - The memory/context API
- [Claude Code](https://claude.ai/code) by [Anthropic](https://anthropic.com) - The AI coding assistant

## License

MIT
