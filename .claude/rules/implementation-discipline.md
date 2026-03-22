# Implementation Discipline

This file enforces the invariant Spec-Driven Development Flow defined in CLAUDE.md.

## Concept Hierarchy (Immutable)

**Spec > Wave > Task**

- A Spec contains one or more Waves
- A Wave contains one or more Tasks
- These relationships are never violated

## Step 1: Spec-First Rule

Before writing ANY implementation code (new features, bug fixes, refactors):
1. Check if an active spec exists via `dossier action=status`
2. If no spec → create one via `/alfred:brief` or `dossier action=init` (minimum S size)
3. Never skip this step — even for "small" changes
4. Enforced: UserPromptSubmit DIRECTIVE + PreToolUse DENY

## Step 2: Self-Review Rule (All Sizes)

After all spec documents are created:
1. MUST run self-review (delegate to `alfred:code-reviewer` agent or `/alfred:inspect`)
2. Fix all Critical and Warning findings
3. This applies to ALL sizes including S

## Step 3: User Approval (M/L Only)

- M/L specs require user approval via `alfred dashboard` before implementation
- S specs are exempt from user approval
- Enforced: PreToolUse DENY + dossier complete validation

## Step 4: Implementation (Per Wave)

### Per Task Completion
- tasks.md checkbox auto-updated by PostToolUse hook (autoCheckTasks)
- tasks.md Next Steps auto-updated by PostToolUse hook (autoCheckNextSteps)

### Per Wave Completion
1. **Commit** — Commit at Wave boundaries, include Wave number in message
2. **Self-Review** — MUST run self-review before proceeding to next Wave
   - Enforced: review-gate.json DENY blocks Edit/Write until cleared
   - If review finds Critical/High: enter fix_mode → fix → re-review → clear (loop until 0 findings)
   - fix_mode has 60-minute timeout — auto-expires to DENY if not cleared
   - Clear via `dossier action=gate sub_action=clear reason="..."` (reason ≥ 30 chars required)
   - reason MUST include: review method, findings count (Critical/High/Medium), fix summary
   - Example: `reason="code-reviewer: 0 Critical, 2 Medium fixed (regex normalization, error message)"`
3. **Knowledge Accumulation** — Save learnings via `ledger save` (decision/pattern/rule)
   - If no knowledge to save, state the reason explicitly
4. **Continue to next Wave** — After gate clear, proceed immediately to next Wave or Closing Wave. Do NOT stop and wait for user input

## Step 5: Completion

After all Waves (including Closing Wave) are done:
1. Final self-review (Closing Wave checkbox)
2. Call `dossier action=complete` to close the spec
3. Stop hook will remind about unchecked items (CONTEXT, not DENY)
