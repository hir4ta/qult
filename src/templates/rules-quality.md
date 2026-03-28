# Quality Rules (qult)

## Test-Driven
- Write the test file FIRST, then implement
- At least 2 meaningful assertions per test case
- Do not mark implementation as complete until tests pass

## Task Scope
- Quick fix (no plan): keep changes focused — 1-2 files per logical change
- Planned work: follow the plan's task boundaries — scope is set by the plan

## When Stuck
- After 2 failed attempts, /clear and try a different approach

## Plan Structure

When writing a plan, use this structure:

```
## Context
Why this change is needed.

## Tasks
### Task N: <name> [pending]
- **File**: <path> (include consumer files: tests, docs, registries)
- **Change**: <what to do>
- **Boundary**: <what NOT to change>
- **Verify**: <test file : test function>

## Success Criteria
- [ ] `<specific command>` — expected outcome
```

Update task status to [done] as you complete each task.
