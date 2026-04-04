---
name: review
description: "Independent 3-stage code review: Spec compliance → Code quality → Security. Spawns specialized reviewers, then filters by Succinctness/Accuracy/Actionability. Use before a major commit or as a review gate. NOT for trivial changes."
---

# /qult:review

Three-stage code review: independent specialized reviewers → Judge filter.

> **Quality by Structure, Not by Promise.**
> Three pairs of eyes, each seeing what the others miss.
> The Wall blocks completion until all three stages pass.

## Stage 0: Run on_review gates (runtime verification)

Before spawning reviewers, run any `on_review` gates defined in `.qult/gates.json`:

1. Read `.qult/gates.json` — if no `on_review` section, skip to Stage 1
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
5. If no plan file exists or no Verify fields are found, skip this stage entirely

## Stage 1: Spec Reviewer (implementation completeness)

Spawn one `spec-reviewer` agent.

In the agent prompt, include:
- The on_review gate results from Stage 0 (if any)
- The plan acceptance criteria from Stage 0.5 (if any)
- One-line instruction: "Verify the uncommitted changes match the plan and all consumers are updated."

The spec-reviewer evaluates **Completeness** and **Accuracy** in an independent context.

Collect output: `Spec: PASS/FAIL`, `Score: Completeness=N Accuracy=N`, findings.

## Stage 2: Quality Reviewer (design & maintainability)

Spawn one `quality-reviewer` agent.

In the agent prompt, include:
- The on_review gate results from Stage 0 (if any)
- One-line instruction: "Review the uncommitted changes for design quality and maintainability issues."

The quality-reviewer evaluates **Design** and **Maintainability** in an independent context.

Collect output: `Quality: PASS/FAIL`, `Score: Design=N Maintainability=N`, findings.

## Stage 3: Security Reviewer (vulnerability & hardening)

Spawn one `security-reviewer` agent.

In the agent prompt, include:
- One-line instruction: "Review the uncommitted changes for security vulnerabilities and hardening gaps."

The security-reviewer evaluates **Vulnerability** and **Hardening** in an independent context.

Collect output: `Security: PASS/FAIL`, `Score: Vulnerability=N Hardening=N`, findings.

## Stage 4: Judge filter

For EACH finding from ALL three reviewers, verify:
- **Succinctness**: Clear and to the point? Not vague or rambling?
- **Accuracy**: Technically correct in this codebase's context? Not a false positive?
- **Actionability**: Includes a concrete fix? Not just "consider X"?

Discard findings that fail any criterion. Report only what passes all three.

## Stage 5: Score aggregation & iteration

After Stage 4, aggregate all scores:

```
Total: Completeness + Accuracy + Design + Maintainability + Vulnerability + Hardening = N/30
```

The SubagentStop hook enforces score thresholds for each reviewer independently.
When any reviewer's score is below threshold or verdict is FAIL, SubagentStop blocks.

When blocked:
1. Fix the issues identified by the failing reviewer(s)
2. Re-spawn ONLY the failing reviewer(s) on the updated diff
3. Re-apply Judge filter on new findings

Maximum 3 iterations total. After max iterations, the review proceeds regardless.

## Output

Summary block showing all three stages:

```
## Review Summary

### Spec: PASS — Completeness=5 Accuracy=4
No issues found.

### Quality: PASS — Design=4 Maintainability=4
1 finding (0 critical, 0 high, 1 medium)

### Security: PASS — Vulnerability=5 Hardening=4
No issues found.

### Aggregate: 26/30
```

Then for each passing finding from the Judge filter:
```
[severity] file:line — description
Fix: concrete suggestion
```

If all three stages pass with no findings: "Review complete. All clear."

## Stage 6: Record review completion

**This step is mandatory.** After all stages pass and the summary is output:

1. Call `mcp__plugin_qult_qult__record_review({ aggregate_score: <total> })` to record the review completion in session state
2. This enables the commit gate to allow commits. Without this call, the commit gate will block.

This is the authoritative signal that review is complete. SubagentStop hooks provide additional enforcement but are not the primary mechanism.
