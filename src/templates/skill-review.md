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

## Stage 3: Iterative improvement (score-driven)

After Stage 2, the SubagentStop hook enforces an aggregate score threshold mechanically.
When the reviewer's aggregate score (Correctness + Design + Security) is below the threshold,
SubagentStop blocks with the current score and iteration count.

When blocked:
1. Fix the weakest dimension(s) identified by findings
2. Re-spawn `qult-reviewer` on the updated diff
3. Re-apply Judge filter on new findings

Maximum 3 iterations (calibration-controlled). After max iterations, the review proceeds regardless.

If no scores are present in reviewer output (legacy format), fall back to severity-based
iteration: fix critical/high findings and re-review, max 2 cycles.

## Output

Summary line: `Review: N findings (X critical, Y high)` or `Review: 0 findings`

Then for each passing finding:
```
[severity] file:line — description
Fix: concrete suggestion
```
