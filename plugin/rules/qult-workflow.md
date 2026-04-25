# qult workflow

qult is installed for this user. Follow these workflow rules when working in any qult-enabled project.

## Detect qult-enabled project

A project is qult-enabled if `mcp__plugin_qult_qult__get_project_status` returns a valid session. If the MCP tool is unavailable or the project is not registered, treat these rules as inactive and proceed normally.

## Top-level workflow

For non-trivial work in a qult-enabled project, follow this sequence:

1. **Plan** — when starting a feature, refactor, or multi-file change, run `/qult:plan-generator` to produce a structured plan. Do NOT use `EnterPlanMode` directly (manual plans bypass plan-evaluator).
2. **Implement** — write code according to the plan. Use `TaskCreate` to track each plan task; mark tasks `in_progress` when starting and `completed` when done.
3. **Review** — for any change spanning 5+ files, OR before any commit when a plan is active, run `/qult:review` (4-stage independent review).
4. **Finish** — when all tasks are complete and review passed, run `/qult:finish` to handle commit/PR/hold/discard.

## Status awareness

At the start of each task and before any commit, call `mcp__plugin_qult_qult__get_project_status` to check pending fixes, test pass state, and review completion. If `/qult:status` is more convenient, invoke it instead.

## Skill-first

Prefer qult skills over ad-hoc shell commands when they apply:
- `/qult:status` — current state snapshot
- `/qult:debug` — structured root-cause analysis on bugs
- `/qult:review` — 4-stage independent review
- `/qult:finish` — branch completion checklist
