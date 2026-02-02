# honcho-clawd Issues

## 1. Enable/Disable Not Working

**Problem:** There's no way to temporarily disable honcho-clawd without fully uninstalling it.

**Current state:**
- Only `install` and `uninstall` commands exist
- No `enable` or `disable` command
- Users have to fully uninstall hooks to stop honcho-clawd

**Fix needed:**
- Add `enabled` field to `HonchoCLAWDConfig` in `src/config.ts`
- Add `honcho-clawd enable` command
- Add `honcho-clawd disable` command
- Update all hooks to check enabled state and exit early if disabled
- Update `status` command to show enabled/disabled state

**Files to modify:**
- `src/config.ts` - add `enabled?: boolean` field
- `src/cli.ts` - add enable/disable commands
- `src/hooks/session-start.ts` - check enabled state
- `src/hooks/session-end.ts` - check enabled state
- `src/hooks/user-prompt.ts` - check enabled state
- `src/hooks/post-tool-use.ts` - check enabled state
- `src/hooks/pre-compact.ts` - check enabled state

---

## 2. Claude Skills Not Installing

**Problem:** Skills are defined but never installed to Claude settings.

**Current state:**
- Skills defined in `.claude/skills.json` (project-local)
- `installHooks()` only installs hooks, not skills
- User's `~/.claude/settings.json` has hooks but no `skills` array
- Skills like `/honcho-clawd-status`, `/honcho-clawd-list` etc. don't work

**Fix needed:**
- Update `installHooks()` in `src/install.ts` to also install skills
- Read skills from `.claude/skills.json`
- Merge them into `~/.claude/settings.json` under a `skills` key
- Handle skill updates/removal on uninstall

**Files to modify:**
- `src/install.ts` - add skill installation logic

**Skills that should be installed:**
- `honcho-clawd-handoff` - Generate research handoff summary
- `honcho-clawd-config` - View/edit configuration
- `honcho-clawd-list` - List all sessions
- `honcho-clawd-status` - Show current status
- `honcho-clawd-new` - Create new session
- `honcho-clawd-clear` - Clear session mapping
- `honcho-clawd-switch` - Switch sessions

---

## 3. Minor: Rename install to be clearer

**Suggestion:** Consider renaming or adding aliases:
- `honcho-clawd install` -> installs hooks AND skills
- `honcho-clawd uninstall` -> removes hooks AND skills
- Make `enable`/`disable` the primary way to toggle without removing

---

## Implementation Order

1. Add `enabled` field to config
2. Add enable/disable CLI commands
3. Update hooks to check enabled state
4. Add skills installation to install.ts
5. Test full workflow
