---
name: attend
description: >
  Fully autonomous development orchestrator. Given a task description, runs the
  complete workflow: spec creation with per-file review, user approval gate,
  phase-by-phase implementation with incremental progress tracking, self-review,
  test gate, and auto-commit. Updates session.md after each task completion for
  real-time dashboard progress. Use when wanting end-to-end task completion from
  spec to commit, "implement this", "build this feature", or fully autonomous
  development. NOT for planning only (use /alfred:brief). NOT for code review
  only (use /alfred:inspect).
user-invocable: true
argument-hint: "task-slug description"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git diff *, git log *, git show *, git status *, git add *, git commit *, git merge-base *, git stash *, go test *, go vet *), AskUserQuestion, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__ledger
---

# /alfred:attend — Autonomous Development Orchestrator

Execute the FULL workflow below without asking the user for input (except at
approval gates and BLOCKED recovery).

- For review prompt templates, see [review-prompts.md](review-prompts.md)
- For BLOCKED recovery and error handling, see [recovery.md](recovery.md)

## Phase 0: Initialize

1. Parse `$ARGUMENTS` → extract `task-slug` (first word) and `description` (rest)
2. Call `dossier` action=status with task_slug
3. **If spec exists with `## Orchestrator State`**:
   - Read state block → determine current phase
   - If `awaiting_approval: true` → call `dossier` action=review to check status:
     - approved → advance to Phase 3
     - changes_requested → read comments, apply fixes, resume at Phase 2
     - pending → remind user to review, STOP
   - If `blocked: true` → ask how it was resolved via AskUserQuestion → resume
   - Otherwise resume from persisted phase
4. **If spec exists without Orchestrator State** → ask: "Spec exists from /alfred:brief. Start implementation from Phase 3, or re-run spec review first?"
5. **If no spec** → ask 1 question: "Confirm scope: {description}. Proceed?"
   - Init spec via `dossier` action=init
6. Record `initial_commit` = output of `git rev-parse HEAD`
7. Write initial Orchestrator State to session.md

## Phase 1: Spec Creation (per-file with review)

Create each spec file with inline multi-perspective review. No sub-agents.
**Update session.md after each file is completed.**

### 1a. Research
- Call `knowledge` tool for relevant patterns and best practices
- Read key source files relevant to the task

### 1b. requirements.md
- Write requirements with confidence scores
- Review from 3 perspectives (Architect, Devil's Advocate, Researcher)
- Apply fixes → save via `dossier` action=update
- **Update session.md**: mark requirements as done

### 1c. design.md
- Write design with architecture, components, alternatives
- Review from 3 perspectives
- Apply fixes → save via `dossier` action=update
- **Update session.md**: mark design as done

### 1d. decisions.md
- Write all decisions with rationale, alternatives, source perspective
- Review from 3 perspectives
- Apply fixes → save via `dossier` action=update
- **Update session.md**: mark decisions as done

### 1e. session.md
- Write final session.md with Next Steps task breakdown
- Update state: `phase: approval-gate`

## Phase 2: Approval Gate

Wait for user approval before proceeding to implementation:

1. Update Orchestrator State: `awaiting_approval: true`
2. Tell the user:
   ```
   Spec complete. Review the files directly or use `alfred dashboard`.
   Tell me "approved" or give feedback.
   ```
3. **STOP and wait** — do not proceed until user confirms.
4. When user responds, call `dossier` action=review:
   - `approved` → advance to Phase 3
   - `changes_requested` → read comments, fix spec files, return to this gate
   - `pending` → remind user
5. Update state: `awaiting_approval: false, phase: impl-phase-1`

## Phase 3: Implementation

Read task breakdown from session.md Next Steps.

**Per implementation task:**
1. Record: `phase_start_commit` = `git rev-parse HEAD`
2. Read the task from Next Steps
3. Implement using Edit/Write/Bash — work directly
4. **Immediately update session.md**: mark this task as `[x]` done
5. Proceed to Phase 4 (per-task review)

**CRITICAL**: Update session.md after EACH task, not all at once.
This ensures the dashboard shows real-time progress.

## Phase 4: Per-Task Review (inline)

After each implementation task:

1. Get diff: `git diff {phase_start_commit}` (only this task's changes)
2. Review inline from 3 perspectives:
   - **Correctness**: Does the code match the spec? Any bugs?
   - **Security**: Any injection, auth, or data exposure issues?
   - **Integration**: Does it work with existing code? Breaking changes?
3. Apply fixes if needed

On PASS: advance to next task (Phase 3) or Phase 5 if all tasks done.

## Phase 5: Final Self-Review

1. Get full diff: `git diff {initial_commit}..HEAD`
2. Review inline from 3 perspectives:
   - **Code quality**: Style, naming, error handling consistency
   - **Spec compliance**: Does implementation match requirements + design?
   - **Integration**: Any cross-cutting concerns missed?
3. Apply fixes if needed (max 1 iteration)
4. Security Critical → BLOCKED
5. Update state: `phase: test-gate`

## Phase 6: Test Gate

1. Run `go test ./...` (timeout: 120s)
2. Run `go vet ./...` (timeout: 120s)
3. If failure:
   - **Compilation error** → fix → re-run
   - **Test failure** → check spec, fix → re-run
   - **Panic/timeout** → BLOCKED if cause unclear
4. Max 2 fix iterations. Still failing → BLOCKED.
5. Update state: `phase: commit`

## Phase 7: Commit and Complete

1. Get changed files: `git diff --name-only {initial_commit}..HEAD`
2. **Path filter**: exclude `.env*`, `*.key`, `*.pem`, `credentials*`, `secret*`
3. Stage specific files: `git add <file1> <file2> ...` (never `git add -A`)
4. **Credential scan**: check `git diff --cached` for potential secrets → BLOCKED if found
5. Commit: `feat: <task-slug>: <one-line summary>`
6. **MUST complete the task**: `dossier action=complete task_slug=<task-slug>`
7. Update state: `phase: done`
8. Output completion summary

**CRITICAL**: Step 6 is mandatory. Every completed attend run MUST call
`dossier action=complete` to close the spec. No exceptions.

## State Persistence

After EVERY phase transition and after EVERY task completion:
- Update `## Orchestrator State` in session.md via `dossier` action=update
- Include: phase, iteration, blocked status, awaiting_approval
- Mark completed Next Steps as `[x]`

## Guardrails

- NEVER skip review phases — they are mandatory quality gates
- NEVER commit with unresolved Critical findings
- NEVER spawn sub-agents for spec creation or review — all inline (rate limit prevention)
- ALWAYS update session.md after each individual task completion (not in batch)
- ALWAYS call `dossier action=complete` at the end — never leave a task open
- ALWAYS record decisions and trade-offs in decisions.md
