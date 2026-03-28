---
name: qult-plan-review
description: "Independent plan evaluation using a separate evaluator agent. Spawns qult-plan-evaluator to assess plan quality, then filters findings by relevance and accuracy. Use for large plans (4+ tasks) before exiting plan mode. NOT for small plans (<=3 tasks)."
---

# /qult:plan-review

Two-stage plan evaluation: independent Evaluator -> Judge filter.

## Stage 1: Evaluator (independent agent)

Spawn one `qult-plan-evaluator` agent. It reads the plan file directly and cross-references against the codebase.

The evaluator assesses scope, coherence, and verifiability in an independent context.

## Stage 2: Judge filter

For each finding returned by the evaluator, verify:
- **Relevance**: Does this actually affect implementation success?
- **Accuracy**: Is the concern valid given this codebase's structure?
- **Actionability**: Is the fix suggestion concrete enough to act on?

Discard findings that fail any criterion. Report only what passes all three.

## Stage 3: Fix cycle (if critical/high findings)

If Stage 2 outputs any critical or high findings:
1. Fix the plan based on findings
2. Re-spawn `qult-plan-evaluator` on the updated plan
3. Re-apply Judge filter

Maximum 2 fix cycles. After 2 cycles, report remaining findings without further iteration.

## Output

Summary line: `Plan evaluation: N findings (X critical, Y high)` or `Plan evaluation: PASS`

Then for each passing finding:
```
[severity] Task N: name — description
Fix: concrete suggestion
```
