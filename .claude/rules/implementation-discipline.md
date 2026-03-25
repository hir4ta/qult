# Implementation Discipline

This file enforces the invariant Spec-Driven Development Flow defined in CLAUDE.md.

## Concept Hierarchy (Immutable)

**Spec > Wave > Task**

- A Spec contains one or more Waves
- A Wave contains one or more Tasks
- These relationships are never violated

## Step 1: Spec Creation (User-Initiated)

Spec creation is user-initiated. Users explicitly request spec creation (e.g., "spec作って", "/alfred:brief").
- Do NOT auto-propose spec creation before implementation
- When user requests a spec: ask for size (S/M/L) → create via `dossier action=init`
- Implementation without a spec is normal and allowed

## Step 2: Self-Review Rule (All Sizes)

After all spec documents are created:
1. MUST run self-review (delegate to `alfred:code-reviewer` agent or `/alfred:inspect`)
2. Fix all Critical and Warning findings
3. This applies to ALL sizes including S

## Step 3: Implementation (Per Wave)

### Per Task Completion
- 明示的更新: `dossier action=check task_id="T-X.Y"`
- Wave 内の全タスク checked → `dossier check` が自動で review-gate を設定 + status を "review" に遷移
- PostToolUse も git commit 検出時に同じ wave completion 検出を行う（二重保護）

### Per Wave Completion
1. **Commit** — Commit at Wave boundaries, include Wave number in message
2. **Self-Review** — MUST run self-review before proceeding to next Wave
   - Enforced: dossier check + PostToolUse の両方が review-gate を自動設定
   - Enforced: review-gate.json DENY blocks Edit/Write until cleared
   - If review finds Critical/High: enter fix_mode → fix → re-review → clear (loop until 0 findings)
   - FR-9: fix_mode 後の gate clear は `re_reviewed=true` が必須（PostToolUse が Agent レビューレスポンスを検出して自動セット）
   - fix_mode has 60-minute timeout — auto-expires to DENY if not cleared
   - Clear via `dossier action=gate sub_action=clear reason="..."` (reason ≥ 30 chars required)
   - reason MUST include: review method, findings count (Critical/High/Medium), fix summary
   - Example: `reason="code-reviewer: 0 Critical, 2 Medium fixed (regex normalization, error message)"`
3. **Knowledge Accumulation** — Save learnings via `ledger save` (decision/pattern/rule)
   - If no knowledge to save, state the reason explicitly
4. **Continue to next Wave** — After gate clear, proceed immediately to next Wave or Closing Wave. Do NOT stop and wait for user input

## Step 4: Completion

After all Waves (including Closing Wave) are done:
1. Final self-review (Closing Wave checkbox)
2. Call `dossier action=complete` to close the spec
   - Blocked if: review-gate active, validation fails, or unchecked tasks remain
   - PreCompact auto-complete also respects review-gate (skips if gate active)
3. Stop hook will remind about unchecked items (CONTEXT, not DENY)
