---
name: qult-review
description: "Independent code review using a separate evaluator agent (HubSpot 2-stage pattern). Spawns qult-reviewer to find issues, then filters findings by Succinctness/Accuracy/Actionability. Use when completing a milestone, before a major commit, or as a review gate in a plan. NOT for trivial changes (typo, rename, log line)."
---

# /qult:review

Two-stage code review: independent Reviewer → Judge filter.

## Stage 1: Reviewer (independent evaluator)

Spawn one `qult-reviewer` agent with the diff to review.
The reviewer evaluates correctness, design, and security in an independent context.

## Stage 2: Judge filter

For each finding returned by the reviewer, verify:
- **Succinctness**: Clear and to the point? Not vague or rambling?
- **Accuracy**: Technically correct in this codebase's context? Not a false positive?
- **Actionability**: Includes a concrete fix? Not just "consider X"?

Discard findings that fail any criterion. Report only what passes all three.

## Stage 3: Fix cycle (if critical/high findings)

If Stage 2 outputs any critical or high findings:
1. Fix all critical and high issues immediately
2. Re-spawn `qult-reviewer` on the updated diff
3. Re-apply Judge filter on new findings

Maximum 2 fix cycles. After 2 cycles, report any remaining findings without further iteration.

## Output

Summary line: `Review: N findings (X critical, Y high)` or `Review: 0 findings`

Then for each passing finding:
```
[severity] file:line — description
Fix: concrete suggestion
```
