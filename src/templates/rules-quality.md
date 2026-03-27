---
description: alfred quality enforcement — fix errors first, small tasks, test-driven
---

# Quality Rules (alfred)

## Fix First
- Fix lint/type errors before editing other files
- Prefer early return over deeply nested if/else

## Task Scope
- Quick fix (no plan): keep changes focused — 1-2 files per logical change
- Planned work: follow the plan's task boundaries — scope is set by the plan
- Keep each logical change under 200 lines of diff — split if larger
- Commit after each working increment, not in large batches

## Test-Driven
- Write the test file FIRST, then implement
- At least 2 meaningful assertions per test case
- Do not mark implementation as complete until tests pass

## Before Commit
- Run tests — commit is blocked until tests pass
- Run /alfred:review — required when plan is active or 5+ files changed. Small changes can skip

## When Stuck
- After 2 failed attempts, /clear and try a different approach