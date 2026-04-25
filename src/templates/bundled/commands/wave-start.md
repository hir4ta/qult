# /qult:wave-start

Begin the next incomplete Wave on the active spec.

## Process

1. Call MCP `get_active_spec`. Refuse if `null`.
2. Read `current_wave` from the response. Refuse with `all Waves complete; run /qult:finish`
   if it's `null`.
3. Read `tasks.md`, find the matching `## Wave N:` block; extract `Goal`, `Verify`, `Scaffold`.
4. Capture HEAD via `git rev-parse HEAD` and write a fresh `waves/wave-NN.md`:
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
5. Print the Wave's task list with `[ ]` checkboxes so the user knows what to implement.

## Don'ts

- Do not auto-set tasks to `in_progress` — only the implementing agent decides.
- Do not begin a Wave whose prior Waves still have non-`done` tasks.
- Do not call `complete_wave` here.
