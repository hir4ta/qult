---
name: spec
description: "Start a new SDD spec under .qult/specs/<name>/. Runs requirements → clarify → design → tasks with a gate at each phase. Use when starting any non-trivial feature. Replaces /qult:plan-generator from v0.x."
argument-hint: "<spec-name> <feature description>"
---

# /qult:spec

End-to-end orchestrator for the SDD lifecycle. Consumes `$ARGUMENTS` as `<spec-name> <feature description...>`.

> **C-hybrid lifecycle.** Spec drafting is a continuous flow with mandatory gates; Wave implementation is explicit (`/qult:wave-start` etc.).

## Pre-flight

1. Parse `$ARGUMENTS`: first whitespace-separated token is `<spec-name>`, the rest is the feature description.
2. Validate `<spec-name>` against `^[a-z0-9][a-z0-9-]{0,63}$`. Reserved name `archive` is rejected.
3. Call `mcp__plugin_qult_qult__get_active_spec`. If a non-archived spec already exists, refuse with: "active spec already exists: <name>. Run /qult:finish first."
4. Detect the architect's language from the feature description; carry it forward as `Output language: <name>` in every agent prompt.

## Stage 1 — requirements draft

1. Spawn `spec-generator` with `phase=requirements`, the feature description, and the output-language note.
2. Write the agent's markdown to `.qult/specs/<spec-name>/requirements.md` via the orchestrator (no MCP tool — this is plain file write).
3. Initialize spec_eval scoring by calling the new-spec reset implicit in `mcp__plugin_qult_qult__record_spec_evaluator_score` (the first call resets the spec_eval block).

## Stage 2 — clarify (mandatory)

Loop, max 3 rounds:

1. Spawn `spec-clarifier` in **generate mode**, passing the current `requirements.md`.
2. Present its question list to the architect verbatim. Wait for replies.
3. Spawn `spec-clarifier` in **apply mode**, passing the architect's replies. It returns the updated `requirements.md`.
4. Persist the updated file.
5. If the clarifier emits a `## Scope-rename suggestion` block, surface it to the architect and ask whether to rename. If yes, abort this skill cleanly: ask the architect to re-run `/qult:spec <new-name> ...`.

When all questions are `[closed]` OR the round count hits 3 and the architect chooses force-progress, exit the loop. **Skipping clarify is not allowed**.

## Stage 3 — requirements gate

1. Spawn `spec-evaluator` with `phase=requirements`. Use `temperature: 0`.
2. If `total ∈ [threshold-1, threshold+1]`, re-spawn once and average (round half-up).
3. Call `mcp__plugin_qult_qult__record_spec_evaluator_score(phase="requirements", total, dim_scores, forced_progress=false, iteration=N)`.
4. On pass → Stage 4. On fail (max 3 iterations) → spawn the spec-generator again with the evaluator's `feedback` to revise requirements.md, then re-evaluate.
5. After 3 failed iterations, ask the architect: `force-progress / abort`. If force-progress, set `forced_progress: true` on the next score record and proceed.

## Stage 4 — design

1. Spawn `spec-generator` with `phase=design`. Persist `design.md`.
2. Run the gate exactly like Stage 3 with `phase=design` (threshold 17/20).

## Stage 5 — tasks

1. Spawn `spec-generator` with `phase=tasks`. Persist `tasks.md`.
2. Run the gate with `phase=tasks` (threshold 16/20).

## Output

```
Spec drafted: .qult/specs/<name>/{requirements,design,tasks}.md
Gates: requirements N/20 · design N/20 · tasks N/20
Next: /qult:wave-start to begin Wave 1
```

## Don'ts

- Don't run `EnterPlanMode` — that path was retired.
- Don't skip clarify under any condition; minimum 1 round is mandatory.
- Don't write spec files in any directory other than `.qult/specs/<name>/`.
- Don't call `record_spec_evaluator_score` with `forced_progress: true` unless the architect explicitly chose it.
