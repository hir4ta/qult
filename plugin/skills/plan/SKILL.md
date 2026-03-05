---
name: plan
description: >
  Butler Protocol: 対話的にspecを生成する。要件定義→設計→タスク分解を行い、
  .alfred/specs/ に保存。Compact/セッション喪失に強い開発計画を作成する。
  Use when: (1) 新しいタスクを始める, (2) 設計を整理したい, (3) 作業を再開する前に計画を立てたい。
user-invocable: true
argument-hint: "<task-slug> [description]"
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__butler-init, mcp__alfred__butler-update, mcp__alfred__butler-status
context: current
---

# /alfred:plan — Butler Protocol Spec Generator

対話的にspecを生成し、Compact/セッション喪失に強い開発計画を作る。

## Core Principle
**Compactで最も失われるのは「推論過程」「設計判断の理由」「探索の死に筋」「暗黙の合意」。**
これらを明示的にファイルに書き出すことで、どのタイミングでセッションが切れても完璧に復帰できるspecを作る。

## Steps

1. **[WHAT]** Parse $ARGUMENTS:
   - task-slug（必須）: URL-safe identifier
   - description（任意）: 概要
   - 引数がなければ AskUserQuestion で確認

2. **[HOW]** Call `butler-status` to check existing state:
   - If active spec exists for this slug → resume mode (skip to Step 7)
   - If no spec → creation mode (continue)

3. **[HOW]** Requirements gathering (対話, 最大3問):
   - What is the goal? (1文で)
   - What does success look like? (計測可能な条件)
   - What is explicitly out of scope?

4. **[HOW]** Design decisions (対話 + knowledge検索):
   - Call `knowledge` to search for relevant best practices
   - Discuss architecture approach
   - Record alternatives considered (CRITICAL for compact resilience)

5. **[HOW]** Task breakdown:
   - Break into concrete, checkable tasks
   - Order by dependency

6. **[HOW]** Call `butler-init` with gathered information:
   - Creates all 6 files with templates
   - Then call `butler-update` for each file to fill in gathered content:
     - requirements.md: replace with full requirements
     - design.md: replace with design decisions
     - tasks.md: replace with task checklist
     - decisions.md: append initial design decisions
     - session.md: replace with current position + next steps

7. **[OUTPUT]** Confirm to user:
   ```
   Butler Protocol initialized for '{task-slug}'.

   Spec files: .alfred/specs/{task-slug}/
   - requirements.md ✓
   - design.md ✓
   - tasks.md ✓
   - decisions.md ✓
   - knowledge.md ✓
   - session.md ✓

   DB synced: {N} documents indexed.

   Compact resilience: Active. Session state will auto-save before compaction.
   Session recovery: Active. Context will auto-restore on session start.

   Ready to implement. Start with the first task in tasks.md.
   ```

## Resume Mode (from Step 2)

If an active spec already exists:
1. Call `butler-status` to get current session state
2. Read spec files in recovery order:
   - session.md (where am I?)
   - requirements.md (what am I building?)
   - design.md (how?)
   - tasks.md (what's done/remaining?)
   - decisions.md (why these choices?)
   - knowledge.md (what did I learn?)
3. Present summary: "Resuming task '{slug}'. Last position: {current_position}. Next steps: {next_steps}"
4. Ask: "Continue from here, or update the plan?"

## Guardrails

- Do NOT skip requirements gathering — even for "obvious" tasks
- Do NOT leave decisions.md empty — record at least the initial approach decision
- Do NOT create tasks without success criteria
- ALWAYS record alternatives considered, even if only briefly
- ALWAYS update session.md with current position after plan completion
