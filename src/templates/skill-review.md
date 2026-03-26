---
name: alfred-review
description: "Multi-agent code review with 3 perspectives (correctness, design, security) and Judge filtering. Use when wanting thorough review before commit, after a milestone, or as a review gate in a plan."
---

# /alfred:review

Deep multi-agent code review. Spawns 3 parallel reviewers, then a Judge filters findings.

## How to run

1. Get the diff to review: `git diff` or `git diff HEAD~1`
2. Spawn 3 alfred-reviewer agents in parallel, each with a different focus:
   - **correctness**: logic errors, edge cases, missing tests, off-by-one, null handling
   - **design**: simplicity, cohesion, coupling, naming, single responsibility
   - **security**: input validation, injection, secrets, unsafe operations
3. Collect all findings
4. **Judge filter**: For each finding, check 3 criteria:
   - **Succinctness**: Is it clear and to the point? (not vague or rambling)
   - **Accuracy**: Is it technically correct in context? (not a false positive)
   - **Actionability**: Does it include a concrete fix suggestion?
5. Only report findings that pass all 3 criteria

## Output format

For each finding that passes the Judge:
- **[severity]** file:line — description
- **Fix**: concrete suggestion

Severity: critical > high > medium > low

## When NOT to use

- Trivial changes (typo, log line, rename) — not worth the cost
- Already reviewed by another tool — avoid duplicate work
