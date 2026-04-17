# qult plan mode

Plan creation in a qult-enabled project must go through the structured pipeline.

## Use /qult:plan-generator

When asked to plan a feature, refactor, or any multi-step change, invoke `/qult:plan-generator` instead of `EnterPlanMode`. The skill spawns a dedicated `plan-generator` agent that analyzes the codebase and produces a task-by-task plan, then automatically runs `plan-evaluator` for scoring.

## Why not EnterPlanMode directly

Manual plans bypass `plan-evaluator` validation. Plan quality is scored across Feasibility / Completeness / Clarity (default threshold: 12). Without that score, weak plans slip through and cause downstream rework.

## When the plan is ready

When all plan tasks are marked `[done]` and verified:
1. Run `/qult:review` (4-stage independent review on the implementation)
2. Run `/qult:finish` (completion checklist) — do NOT commit directly

## Before exiting plan mode (selfcheck)

Before finalizing any plan (whether via plan-generator or otherwise), review the entire session for omissions:
- Missing files
- Untested edge cases
- Migration concerns
- Documentation gaps
- Dependency changes
- Anything discussed but not included in the plan

If any gap is found, update the plan before proceeding.
