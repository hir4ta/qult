---
name: develop
description: >
  Fully autonomous development orchestrator. Given a task description, runs the
  complete workflow: spec creation with 3-agent deliberation, spec review loop,
  phase-by-phase implementation with review gates, final self-review, test gate,
  and auto-commit. No user intervention after initial invocation. Use when
  wanting end-to-end task completion from spec to commit without manual steps,
  "implement this", "build this feature", or fully autonomous development.
  NOT for planning only (use /alfred:plan). NOT for code review only
  (use /alfred:review).
user-invocable: true
argument-hint: "task-slug description"
allowed-tools: Read, Write, Edit, Glob, Grep, Agent, Bash(git diff *, git log *, git show *, git status *, git add *, git commit *, git merge-base *, git stash *, go test *, go vet *), AskUserQuestion, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__spec, mcp__plugin_alfred_alfred__recall
---

# /alfred:develop — Autonomous Development Orchestrator

You are an autonomous development orchestrator. Execute the FULL workflow below
without asking the user for input (except once at the start if needed).

- For spec creation agent prompts, see [spec-agents.md](spec-agents.md)
- For example workflows (basic flow, BLOCKED recovery, resume), see [examples.md](examples.md)
- For review prompt templates, see [review-prompts.md](review-prompts.md)
- For BLOCKED recovery and error handling, see [recovery.md](recovery.md)

## Phase 0: Initialize

1. Parse `$ARGUMENTS` → extract `task-slug` (first word) and `description` (rest)
2. Call `spec` action=status with task_slug
3. **If spec exists with `## Orchestrator State`**:
   - Read state block → determine current phase
   - If `blocked: true` with security reason → ask "Specifically, how did you resolve: {blocked_reason}?" via AskUserQuestion → resume from **same phase** (re-review the fix)
   - If `blocked: true` with non-security reason → ask "Resolved?" → resume from **next phase**
   - Otherwise resume from persisted phase (skip to that phase)
4. **If spec exists without Orchestrator State** → ask AskUserQuestion: "Spec exists from /alfred:plan. Start implementation from Phase 3, or re-run spec review first?"
5. **If no spec** → ask 1 AskUserQuestion: "Confirm scope: {description}. Proceed?"
   - Init spec via `spec` action=init
6. Record `initial_commit` = output of `git rev-parse HEAD`
7. Write initial Orchestrator State to session.md:
   ```
   ## Orchestrator State
   - phase: spec
   - iteration: 0
   - agent_spawns_used: 0
   - total_warnings: 0
   - findings_hash:
   - blocked: false
   - blocked_reason:
   - initial_commit: {sha}
   - phase_start_commit: {sha}
   ```

## Phase 1: Spec Creation

Follow the prompts in [spec-agents.md](spec-agents.md):
1. Research via `knowledge` tool
2. Spawn 3 agents in parallel (Architect, Devil's Advocate, Researcher)
3. Synthesize with a Mediator agent (parent writes spec via `spec` action=update)
4. Write requirements.md, design.md, decisions.md via `spec` action=update
5. Update state: `phase: spec-review, agent_spawns_used: +4`

## Phase 2: Spec Review Loop

Read prompts from [review-prompts.md](review-prompts.md) § Spec Review.

**Per iteration:**
1. Spawn 3 review agents in parallel (Agent A/B/C with fixed perspective assignments)
   - Each agent receives: spec files content + perspective assignment
   - Each agent outputs: structured JSON verdict (PASS or NEEDS_FIXES)
   - Each agent is read-only (no Write/Edit/Agent tools)
   - Agents read spec independently via `spec` action=status (read-only action)
2. Collect verdicts → merge findings → deduplicate
3. Update `agent_spawns_used: +3`

**Termination check** (in order):
1. **Score threshold**: No Critical/High findings → PASS → advance to Phase 3
2. **Security Critical**: Any security-critical finding → BLOCKED (see [recovery.md](recovery.md))
3. **Confidence gate**: Any spec section with `<!-- confidence: N -->` where N ≤ 5 → BLOCKED
4. **Stagnation**: Hash sorted findings (severity+description+file) with SHA-256.
   If hash matches previous `findings_hash` → stop loop, proceed
5. **Max iterations**: iteration ≥ 3 → log unresolved to decisions.md, proceed
6. **Warning accumulation**: `total_warnings` across run > 5 → treat new warnings as High

If continuing: apply fixes to spec files, increment iteration, update findings_hash, loop.

Update state: `phase: impl-phase-1`

## Phase 3: Implementation

Read task breakdown from design.md.

**Per implementation phase (N = 1, 2, ...):**
1. Record: `phase_start_commit` = output of `git rev-parse HEAD`
2. Read phase task from design.md
3. Implement using Edit/Write/Bash — work directly in parent context
4. Update session.md Modified Files
5. Proceed to Phase 4 (per-phase review)

## Phase 4: Per-Phase Review Loop

Read prompts from [review-prompts.md](review-prompts.md) § Code Review.

1. Get diff: `git diff {phase_start_commit}` (only this phase's changes)
2. Spawn 3 review agents in parallel with diff + spec context
   - Each agent outputs structured JSON verdict (PASS or NEEDS_FIXES)
3. Collect → merge → deduplicate

**Termination check** (same as Phase 2, but max iterations = 2)

If continuing: apply fixes, increment iteration, loop.

On PASS: mark phase done in session.md, advance to next impl-phase or Phase 5.

## Phase 5: Final Self-Review

Read prompts from [review-prompts.md](review-prompts.md) § Final Review.

1. Get full diff: `git diff $(git merge-base main HEAD)..HEAD`
2. Spawn 4 agents in parallel (3 code reviewers + 1 integration validator)
   - Integration validator uses the same verdict format: PASS or NEEDS_FIXES
   - Category `integration` signals requirement gaps
3. Collect → merge → deduplicate
4. Max 1 fix iteration. Security Critical → BLOCKED.
5. Update state: `phase: test-gate`

## Phase 6: Test Gate

1. Run `go test ./...` (timeout: 120s)
2. Run `go vet ./...` (timeout: 120s)
3. If failure, classify:
   - **Compilation error** → fix the build error → re-run
   - **Test assertion failure** → check if implementation matches spec, fix accordingly → re-run
   - **Panic/timeout** → likely a deeper issue → BLOCKED if cause unclear
4. Max 2 fix iterations total. Still failing → BLOCKED.
5. Update state: `phase: commit`

## Phase 7: Commit

1. Get changed files: `git diff --name-only {initial_commit}..HEAD`
2. **Path filter**: exclude files matching:
   - `.env*`, `*.key`, `*.pem`, `credentials*`, `secret*`, `*.secret.*`
   - `.claude/settings*.json`
3. Stage specific files: `git add <file1> <file2> ...` (never `git add -A`)
4. **Credential scan**: check `git diff --cached` output for potential secrets
   (long hex/base64 strings in assignment context, `password=`, `token=`, `key=`)
   → If suspicious patterns found → BLOCKED
5. Commit: `feat: <task-slug>: <one-line summary from requirements.md>`
6. Update state: `phase: done`
7. Output completion summary with stats

## Budget Guard

Total agent spawn cap: **20** per run.

Before EVERY agent spawn:
1. Check: `agent_spawns_used + agents_to_spawn ≤ 20`
2. If insufficient for full parallel spawn (3 or 4 agents):
   - Reduce to 1 agent with all perspectives combined
3. If even 1 agent would exceed cap → BLOCKED

Typical consumption: spec(4) + spec-review(3) + impl-review×2(6) + final(4) = 17.

## State Persistence

After EVERY phase transition:
- Update `## Orchestrator State` in session.md via `spec` action=update
- Write phase, iteration, agent_spawns_used, total_warnings, findings_hash, blocked status
- Use mode=replace on session.md (full rewrite, not append)

## Guardrails

- NEVER ask the user after Phase 0 (except BLOCKED recovery on re-invocation)
- NEVER skip review phases — they are mandatory quality gates
- NEVER commit with unresolved Critical findings
- ALWAYS use structured JSON verdicts from review agents
- ALWAYS check budget before spawning agents
- ALWAYS record decisions and trade-offs in decisions.md
