---
description: alfred quality enforcement — fix errors first, small tasks, test-driven
---

# Quality Rules (alfred)

## Fix First
- Fix lint/type errors before editing other files
- Prefer early return over deeply nested if/else

## Small Tasks
- Each task: 1 file, under 15 lines changed
- Keep each logical change under 200 lines of diff — split if larger
- Commit after each working increment, not in large batches

## Test-Driven
- Write the test file FIRST, then implement
- At least 2 meaningful assertions per test case
- Do not mark implementation as complete until tests pass

## Self-Check
- Before completing a task: edge cases tested? silent failures? simpler approach?

## When Stuck
- After 2 failed attempts, /clear and try a different approach
- Run /alfred:review before marking a milestone complete