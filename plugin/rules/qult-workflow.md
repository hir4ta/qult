# qult workflow

qult is installed for this user. Follow these workflow rules in any qult-enabled project.

## Detect qult-enabled project

A project is qult-enabled if `mcp__plugin_qult_qult__get_project_status` returns project state. If the MCP tool is unavailable, treat these rules as inactive and proceed normally.

## Top-level workflow: Spec → Wave → Review → Finish

For non-trivial work:

1. **Spec** — start with `/qult:spec <name> "<description>"`. The orchestrator drives requirements → clarify → design → tasks. Each phase has an evaluator gate. Skipping `/qult:clarify` is not allowed.
2. **Implement Wave by Wave** — `/qult:wave-start` to record the start commit, then implement each task. `/qult:wip` for intermediate commits (auto-prefixes `[wave-NN]`). `/qult:wave-complete` runs tests + detectors + creates the closing commit + records the Range.
3. **Review** — at spec completion (after all Waves done), run `/qult:review` (4-stage independent reviewers). Reviews are not run automatically per Wave (token cost).
4. **Finish** — `/qult:finish` archives the spec (`.qult/specs/<name>/` → `.qult/specs/archive/<name>/`) and offers merge / PR / hold / discard.

## Trivial-change carve-out

For changes touching ≤5 files (typo, lockfile bump, comment), skip the SDD pipeline and commit normally. `/qult:status` will surface a friendly hint when the count crosses 5; the architect decides whether to escalate to `/qult:spec`.

## Status awareness

Before any commit, call `mcp__plugin_qult_qult__get_project_status` (or `/qult:status`) to verify:
- `test_passed_at` is recent
- No high-severity entries in `pending_fixes`
- If a spec is active, the current Wave is in a sensible state (e.g. tasks done, ready to `/qult:wave-complete`)

## Skill-first

Prefer qult skills over ad-hoc shell commands:
- `/qult:status` — current state snapshot
- `/qult:debug` — structured root-cause analysis on bugs
- `/qult:review` — 4-stage independent review at spec completion
- `/qult:finish` — branch completion checklist + spec archival
