---
name: wave-start
description: "Begin the next incomplete Wave on the active spec. Records the Wave start commit (current HEAD) into waves/wave-NN.md so /qult:wave-complete can compute the commit range. Use whenever you sit down to implement another Wave."
---

# /qult:wave-start

Initialize the next Wave's `waves/wave-NN.md` skeleton.

## Steps

1. Get the active spec via `mcp__plugin_qult_qult__get_active_spec`. Refuse if null.
2. From the response, read `current_wave` (the next Wave with non-`done` tasks). Refuse with "all Waves complete; run /qult:finish" if it's `null`.
3. Read `tasks.md`, find the matching `## Wave N:` block; extract `Goal`, `Verify`, `Scaffold` (default false), and any `Fixes:` annotation if this is a review-fix Wave.
4. Capture HEAD via `git rev-parse HEAD` and persist a fresh `waves/wave-NN.md` (use `initWaveFile` from `mcp-tools/spec-tools.ts` if invoked from code, or write the file directly with the canonical schema):
   ```markdown
   # Wave N: <title>
   **Goal**: ...
   **Verify**: ...
   **Started at**: <ISO timestamp>
   **Scaffold**: false
   ## Commits
   (populated on /qult:wave-complete)
   **Range**:
   ## Notes
   **Start commit**: <HEAD-sha>
   ```
5. Print the Wave's task list to the architect with `[ ]` checkboxes so they know what to implement next. Do not mark anything as `in_progress` automatically — the architect or implementing agent decides.

## Don'ts

- Don't call `complete_wave` here.
- Don't auto-set Wave status flags. `update_task_status` is invoked when a task actually starts/finishes.
- Don't begin a Wave whose prior Waves still have non-`done` tasks. Waves are strictly ordered.
