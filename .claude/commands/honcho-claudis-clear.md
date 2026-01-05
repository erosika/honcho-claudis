---
description: Clear custom Honcho session for current directory (revert to default)
allowed-tools: Bash(honcho-claudis:*)
---

# Clear Honcho Session Mapping

## Current Session

!`honcho-claudis session current 2>/dev/null`

## Clearing Session

!`honcho-claudis session clear`

## Instructions

After clearing:
1. Confirm the session mapping was removed
2. Explain that the directory will now use the default session name (based on folder name)
3. Suggest /honcho-claudis-new if they want to set a new custom session
