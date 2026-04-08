---
name: review
description: "Independent 4-stage code review: Spec compliance → Code quality → Security → Adversarial edge cases. Spawns specialized reviewers, then filters by Succinctness/Accuracy/Actionability. Use before a major commit or as a review gate. NOT for trivial changes."
---

# /qult:review

Four-stage code review: independent specialized reviewers → Judge filter.

> **Quality by Structure, Not by Promise.**
> Four pairs of eyes, each seeing what the others miss.
> The Wall blocks completion until all stages pass.

## Stage 0: Run on_review gates (runtime verification)

Before spawning reviewers, run any `on_review` gates:

1. Call `mcp__plugin_qult_qult__get_gate_config()` — if no `on_review` section, skip to Stage 1
2. For each gate in `on_review`, run the command via Bash with the gate's `timeout` value (in ms) as the Bash tool timeout. If no timeout is specified, default to 60000ms.
3. Collect results as a summary block:
   ```
   ## on_review gate results
   - e2e: PASS (12.3s)
   - e2e: FAIL (8.1s) — [first 500 chars of stderr]
   ```
4. Pass this block as context when spawning reviewers

If a gate times out or crashes, record it as `ERROR` and continue. Do not block the review.

## Stage 0.5: Extract plan acceptance criteria

If an active plan exists in `.claude/plans/`, extract acceptance criteria:

1. Read the most recently modified `.md` file in `.claude/plans/`
2. For each `### Task N:` block, extract the **Verify** line
3. Build a compact criteria block:
   ```
   ## Plan acceptance criteria
   - Task 1: <name> — Verify: <test file>:<test function>
   - Task 3: <name> — Verify: <test file>:<test function>
   ```
4. Only include tasks with a non-empty Verify field
5. Also extract **Success Criteria** (bullet points under `## Success Criteria` section):
   ```
   ## Success Criteria (from plan)
   - `bun vitest run` — all tests pass
   - security-check: 8 → ~23 patterns
   ```
6. If no plan file exists or no Verify fields/Success Criteria are found, skip this stage entirely

## Stage 0.7: Collect detector findings (ground truth)

Before spawning reviewers, collect computational detector results as ground truth:

1. Call `mcp__plugin_qult_qult__get_detector_summary()`
2. If the result is NOT "No detector findings.", store it as a `## Detector Findings` block
3. This block will be included in each reviewer's prompt as context

These findings are deterministic (not LLM-generated) and serve as ground truth that reviewers must not contradict.

## Round 1: Spec + Security (parallel — no overlap)

Spawn `spec-reviewer` and `security-reviewer` **in parallel** (single message, two Agent tool calls). These stages have no overlap: Spec checks plan compliance, Security checks vulnerabilities.

### Stage 1: Spec Reviewer

In the agent prompt, include:
- The on_review gate results from Stage 0 (if any)
- The plan acceptance criteria from Stage 0.5 (if any)
- The Success Criteria from Stage 0.5 (if any) — these are the human-written ground truth for spec verification
- The detector findings from Stage 0.7 (if any)
- One-line instruction: "Verify the uncommitted changes match the plan and all consumers are updated. Use Success Criteria as ground truth."

Collect output: `Spec: PASS/FAIL`, `Score: Completeness=N Accuracy=N`, findings.

**Post-validation**: Verify the agent output contains verdict and scores. If missing, re-spawn. Do NOT fabricate scores.

If Spec: PASS, record the scores:
```
mcp__plugin_qult_qult__record_stage_scores({ stage: "Spec", scores: { completeness: N, accuracy: N } })
```

### Stage 3: Security Reviewer

In the agent prompt, include:
- The detector findings from Stage 0.7 (if any)
- One-line instruction: "Review the uncommitted changes for security vulnerabilities and hardening gaps."

Collect output: `Security: PASS/FAIL`, `Score: Vulnerability=N Hardening=N`, findings.

**Post-validation**: Verify verdict, scores, and that the agent did not modify files (read-only).

If Security: PASS, record the scores:
```
mcp__plugin_qult_qult__record_stage_scores({ stage: "Security", scores: { vulnerability: N, hardening: N } })
```

### Round 1 summary

After both agents complete, extract a **1-line summary** of each finding from each reviewer. Build a `Prior findings` block:

```
## Prior findings (do not duplicate)
- Spec: [1-line summary of each finding, or "No issues"]
- Security: [1-line summary of each finding, or "No issues"]
```

## Round 2: Quality + Adversarial (parallel — with Round 1 context)

Spawn `quality-reviewer` and `adversarial-reviewer` **in parallel**. Both receive the Round 1 findings summary to avoid duplicating already-reported issues.

### Stage 2: Quality Reviewer

In the agent prompt, include:
- The on_review gate results from Stage 0 (if any)
- The detector findings from Stage 0.7 (if any)
- The **Prior findings** block from Round 1
- One-line instruction: "Review the uncommitted changes for design quality and maintainability issues. Do not duplicate findings already reported by Spec/Security reviewers."

Collect output: `Quality: PASS/FAIL`, `Score: Design=N Maintainability=N`, findings.

**Post-validation**: Verify verdict and scores. Do NOT fabricate scores.

If Quality: PASS, record the scores:
```
mcp__plugin_qult_qult__record_stage_scores({ stage: "Quality", scores: { design: N, maintainability: N } })
```

### Stage 4: Adversarial Reviewer

In the agent prompt, include:
- The detector findings from Stage 0.7 (if any)
- The **Prior findings** block from Round 1
- One-line instruction: "Find edge cases, logic errors, and silent failures in the uncommitted changes that other reviewers missed. Do not duplicate findings already reported."

Collect output: `Adversarial: PASS/FAIL`, `Score: EdgeCases=N LogicCorrectness=N`, findings.

**Post-validation**: Verify verdict, scores, and that the agent did not modify files (read-only).

Note: Adversarial stage scores are included in the 4-stage aggregate (/40).

If Adversarial: PASS, record the scores:
```
mcp__plugin_qult_qult__record_stage_scores({ stage: "Adversarial", scores: { edgeCases: N, logicCorrectness: N } })
```

## Stage 5: Judge filter

For EACH finding from ALL four reviewers, verify:
- **Succinctness**: Clear and to the point? Not vague or rambling?
- **Accuracy**: Technically correct in this codebase's context? Not a false positive?
- **Actionability**: Includes a concrete fix? Not just "consider X"?
- **Uniqueness**: Not a duplicate of a finding already reported by another reviewer (same file:line, same issue). If duplicate, keep the one from the more relevant stage (e.g., security finding from Security, not Adversarial).

Discard findings that fail any criterion. Report only what passes all four.

## Stage 6: Score aggregation & iteration

After Stage 5, aggregate all scores:

```
Total: Completeness + Accuracy + Design + Maintainability + Vulnerability + Hardening + EdgeCases + LogicCorrectness = N/40
```

The SubagentStop hook enforces score thresholds for each reviewer independently.
When any reviewer's score is below threshold or verdict is FAIL, SubagentStop blocks.

When blocked:
1. Fix the issues identified by the failing reviewer(s)
2. Re-spawn ONLY the failing reviewer(s) on the updated diff
3. Re-apply Judge filter on new findings

Maximum 3 iterations total. After max iterations, the review proceeds regardless.

## Output

Summary block showing all four stages:

```
## Review Summary

### Spec: PASS — Completeness=5 Accuracy=4
No issues found.

### Quality: PASS — Design=4 Maintainability=4
1 finding (0 critical, 0 high, 1 medium)

### Security: PASS — Vulnerability=5 Hardening=4
No issues found.

### Adversarial: PASS — EdgeCases=4 LogicCorrectness=5
No issues found.

### Aggregate: 34/40
```

Then for each passing finding from the Judge filter:
```
[severity] file:line — description
Fix: concrete suggestion
```

If all four stages pass with no findings: "Review complete. All clear."

## Stage 7: Record review completion

**This step is mandatory.** After all stages pass and the summary is output:

1. Call `mcp__plugin_qult_qult__record_review({ aggregate_score: <total> })` to record the review completion in session state
2. This enables the commit gate to allow commits. Without this call, the commit gate will block.

This is the authoritative signal that review is complete. SubagentStop hooks provide additional enforcement but are not the primary mechanism.
