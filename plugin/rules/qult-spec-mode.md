# qult spec mode

qult replaces Claude Code's standard plan mode with **Spec-Driven Development (SDD)** for any non-trivial change.

## Detect qult-enabled project

A project is qult-enabled if `mcp__plugin_qult_qult__get_project_status` returns project state. If the MCP tool is unavailable or the project is not registered, treat these rules as inactive and proceed normally.

## When to use SDD

Use `/qult:spec` when:

- Adding a new feature
- Refactoring across multiple files
- Any change you would have planned manually before this version

Skip SDD (just commit normally) when:

- The change touches **5 or fewer files** (qult will warn but won't block)
- The change is purely a typo/comment/lockfile bump

## Use /qult:spec, not EnterPlanMode

`EnterPlanMode` is **prohibited for implementation work** — it bypasses the spec-evaluator gate.

- Use `/qult:spec <name> "<description>"` to start the SDD pipeline.
- `EnterPlanMode` may still be used for **investigation tasks that do not touch code** (codebase tours, research questions). The moment the task includes file modification, `/qult:spec` is required.

## Wave invariants

Once a spec is active:

- Implementation happens **Wave by Wave**, in strict order.
- Every commit's message MUST start with `[wave-NN]` (NN is 2-digit zero-padded; max 99).
- Wave 1 is always a scaffold — `bun run build` (or equivalent) must succeed at its end.
- Wave Range SHAs (start..end) are recorded by `complete_wave` and must remain reachable. Avoid `git rebase`/`git reset --soft` across Wave boundaries; if you must, run `/qult:wave-complete` to detect the resulting `sha_unreachable` and re-record.

## Branch decoupling

Spec is **decoupled from branch**: `/qult:spec` works on `main` (solo workflow) or any feature branch. The rule is **one non-archived spec per repo state**. The orchestrator refuses a second spec until `/qult:finish` archives the active one.

## Don'ts

- Don't write `requirements.md` / `design.md` / `tasks.md` by hand. Always go through `/qult:spec` so the spec-evaluator gates run.
- Don't skip `/qult:clarify`. Even one round is mandatory.
- Don't use `/qult:wip` to bypass `/qult:wave-complete`. WIP commits are allowed inside a Wave; the closing `complete_wave` MCP call is non-negotiable for Range integrity.
- Don't squash Wave commits. Range binding is range-based, not single-commit.
