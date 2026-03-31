---
name: skip
description: Temporarily disable or re-enable quality gates (lint, typecheck, test, review), or clear false-positive pending fixes. Use when a gate is broken, irrelevant for current work, or producing false positives. NOT for permanently removing gates (edit .qult/gates.json instead).
user_invocable: true
---

# /qult:skip

Manage gate overrides and pending-fix state for the current session.

## Usage

The user will specify what they want:
- "skip lint" / "disable typecheck" -> disable a gate
- "skip review" / "disable review" -> skip independent review requirement
- "re-enable lint" / "enable test" -> re-enable a gate
- "clear fixes" / "clear pending" -> clear all pending fixes

## Steps

### Disable a gate

1. Call `mcp__plugin_qult_qult__disable_gate({ gate_name: "<name>" })`
2. Confirm: "Gate '<name>' disabled for this session. It will not run on edits or block commits."

### Re-enable a gate

1. Call `mcp__plugin_qult_qult__enable_gate({ gate_name: "<name>" })`
2. Confirm: "Gate '<name>' re-enabled."

### Clear pending fixes

1. Call `mcp__plugin_qult_qult__clear_pending_fixes()`
2. Confirm: "All pending fixes cleared."

## Notes

- Disabled gates reset automatically on new sessions
- `review` is a special gate name that skips the independent review requirement
- Valid gate names: any key from `.qult/gates.json` (lint, typecheck, test, etc.) plus `review`
- To see current gate status, use `/qult:status`
- To change thresholds, use `/qult:config`
- To permanently change gates, edit `.qult/gates.json`
