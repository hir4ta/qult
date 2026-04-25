---
name: skip
description: Temporarily disable or re-enable quality gates (lint, typecheck, test, review), or clear false-positive pending fixes. Use when a gate is broken, irrelevant for current work, or producing false positives. NOT for permanently removing gates (re-run /qult:init to reconfigure).
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

1. Ask the architect for a `reason` (≥10 chars, ≥5 unique chars). Required for the audit log.
2. Call `mcp__plugin_qult_qult__disable_gate({ gate_name, reason })`.
3. Maximum 2 gates can be disabled at once — the MCP handler enforces this.
4. Confirm: "Gate '<name>' disabled. Audit entry written."

### Re-enable a gate

1. Call `mcp__plugin_qult_qult__enable_gate({ gate_name })`.
2. Confirm: "Gate '<name>' re-enabled."

### Clear pending fixes

1. Ask the architect for a `reason` explaining why the fixes are false positives.
2. Call `mcp__plugin_qult_qult__clear_pending_fixes({ reason })`.
3. Confirm: "All pending fixes cleared. Audit entry written."

## Notes

- disabled gates persist in `.qult/state/gates.json` (project-local). They do **not** auto-reset across sessions — `/qult:skip` then `/qult:skip` to re-enable.
- `review` is a special gate name that skips the 4-stage independent review requirement.
- Valid gate names: `review`, `security-check`, `semgrep-required`, `test-quality-check`, `dep-vuln-check`, `hallucinated-package-check`.
- All three operations (disable / enable / clear) write to `.qult/state/audit-log.ndjson` for traceability.
- See current state: `/qult:status`. Change thresholds: `/qult:config`.
