---
name: attend
description: >
  Use when wanting end-to-end task completion from spec to commit, "implement
  this", "build this feature", or fully autonomous development. NOT for planning
  only (use /alfred:brief). NOT for code review only (use /alfred:inspect).
user-invocable: true
argument-hint: "task-slug description"
allowed-tools: Read, Write, Edit, Glob, Grep, Agent, Bash(git diff *, git log *, git show *, git status *, git add *, git commit *, git merge-base *, git stash *, go test *, go vet *), AskUserQuestion, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__ledger
---

# /alfred:attend — Autonomous Development Orchestrator

Execute the FULL workflow below without asking the user for input (except at
BLOCKED recovery).

This skill implements the **invariant Spec-Driven Development Flow** (see CLAUDE.md):
Spec > Wave > Task hierarchy. All sizes require self-review.

- For review prompt templates, see [review-prompts.md](review-prompts.md)
- For BLOCKED recovery and error handling, see [recovery.md](recovery.md)

## Red Flags

These thought patterns signal you are about to violate this skill's rules:

- "I'll skip the spec review since it's simple" → Every spec gets 3-agent review. Complexity is misjudged most when it seems low.
- "Let me just commit without the code reviewer" → Per-task review is mandatory. Skipping it means shipping unreviewed code.
- "Session.md doesn't need updating after this small step" → Dashboard progress depends on tasks.md. Update after EVERY task, not in batch.

## Phase 0: Initialize

1. Parse `$ARGUMENTS` → extract `task-slug` (first word) and `description` (rest)
2. Call `dossier` action=status with task_slug
3. **If spec exists with `## Orchestrator State`**:
   - Read state block → determine current phase
   - If `blocked: true` → ask how it was resolved via AskUserQuestion → resume
   - Otherwise resume from persisted phase
4. **If spec exists without Orchestrator State** → ask: "Spec exists from /alfred:brief. Start implementation from Phase 2, or re-run spec review first?"
5. **If no spec** → ask 1 question: "Confirm scope: {description}. Proceed?"
   - Init spec via `dossier` action=init
6. Record `initial_commit` = output of `git rev-parse HEAD`
7. Write initial Orchestrator State to tasks.md

## Phase 1: Spec Creation (7 files with parallel agent review)

Create each spec file, then spawn 3 review agents in parallel.
**Update tasks.md after each file is completed.**
File generation order: research → requirements → design → tasks → test-specs → decisions → session.

### 1a. research.md
- Call `knowledge` tool for relevant patterns and best practices
- Read key source files relevant to the task
- Write research.md: existing code analysis, gap analysis, implementation options, risks
- **Quick check** (inline): scan for critical gaps, placeholder content
- **Update tasks.md**: mark research as done

### 1b. requirements.md
- Write requirements in **EARS notation** (FR-N IDs) with confidence + source scores
- Include acceptance criteria in Given/When/Then format (AC-N.N)
- Include non-functional requirements (NFR-N) with measurable targets
- **Review + fix loop** (key review target):
  - S/D: self-review inline
  - M: 1 agent (Architect) → fix Critical/High → re-review until clean (max 3 rounds)
  - L/XL: 3 agents (Architect, Devil's Advocate, Researcher) → fix → re-review until clean
- **Update tasks.md**: mark requirements as done

### 1c. design.md
- Write design with architecture, **interfaces**, **data models** (SQL), **API contracts**
- Include **Requirements Traceability Matrix** (Req ID → Component → Task ID → Test ID)
- **Review + fix loop** (key review target): same rules as requirements.md
- **Update tasks.md**: mark design as done

### 1d. tasks.md
- Write task decomposition in **Waves** (Foundation → Core → Edge Cases → Polish)
- Each task: T-N.N [S/M/L/XL] (P) description with `_Requirements: FR-N | Depends: T-N.N | Files: path_`
- Include summary, size legend, dependency graph
- **Quick check** (inline): verify dependencies, FR coverage, wave ordering
- **Update tasks.md**: mark tasks as done

### 1e. test-specs.md
- Write **Coverage Matrix** (Req → Test IDs → Type → Priority)
- Write test cases in **Gherkin** with `<!-- source: FR-N -->` annotations
- Map EARS: WHILE→Given, WHEN→When, SHALL→Then
- Include edge case matrix, boundary values, test data, security tests
- **Quick check** (inline): verify FR coverage, Gherkin syntax
- **Update tasks.md**: mark test-specs as done

### 1f. Decisions → ledger
- Save decisions directly via `ledger action=save sub_type=decision` (not as a spec file)
- Include title, context, decision, reasoning, alternatives

### 1g. Clear spec-review gate
After all spec files reviewed and fixed, clear the review gate:
```
dossier action=gate sub_action=clear reason="requirements + design review loop completed. Findings: [summarize]"
```
This is MANDATORY — PreToolUse blocks source Edit/Write until gate is cleared.

## Phase 2: Implementation

Read task breakdown from tasks.md waves.

**Per implementation task:**
1. Read the next unchecked task from tasks.md
2. Implement using Edit/Write/Bash — work directly
3. **Immediately update tasks.md**: mark this task as `[x]` done
4. Continue to next task in the same Wave, or proceed to Phase 3 (Wave boundary) if all tasks in the Wave are done

**CRITICAL**: Update tasks.md after EACH task, not all at once.
This ensures the dashboard shows real-time progress.

## Phase 3: Wave Boundary (commit + review + knowledge)

Per-task review is NOT required. Review happens at Wave boundaries.

When all tasks in a Wave are completed (before starting next Wave):
1. **Commit** changes with Wave number in message
2. **Self-review**: Spawn `alfred:code-reviewer` agent **in foreground** (NOT background) with the Wave's full diff. The agent returns aggregated findings directly — read and act on them immediately
3. If Critical findings → fix and re-review (max 2 iterations)
4. If Warnings only → fix if straightforward, proceed if not
5. **Knowledge accumulation**: Save learnings via `ledger save` (decision/pattern/rule). If no knowledge to save, state the reason explicitly
6. Clear gate: `dossier action=gate sub_action=clear reason="Wave N review: [summary]"`
7. Proceed to next Wave

**IMPORTANT**: Always spawn code-reviewer in **foreground** (default). Do NOT use `run_in_background` — background agents' results are difficult to retrieve and parse. Foreground execution blocks until the review completes, but the results are directly usable.

This is MANDATORY — PostToolUse auto-sets the wave-review gate when a Wave completes. PreToolUse blocks source Edit/Write until the gate is cleared.

## Phase 4: Final Self-Review (code-reviewer agent)

1. Get full diff: `git diff {initial_commit}..HEAD`
2. **Spawn `alfred:code-reviewer` agent in foreground** with the full diff
   - Comprehensive review across security, logic, design
   - Returns aggregated findings directly
3. Apply fixes if needed (max 1 iteration)
4. Security Critical → BLOCKED
5. Update state: `phase: test-gate`

## Phase 5: Test Gate

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
6. Complete the task: `dossier action=complete task_slug=<task-slug>`
7. Update state: `phase: done`
8. Output completion summary

## State Persistence

After EVERY phase transition and after EVERY task completion:
- Update `## Orchestrator State` in tasks.md via `dossier` action=update
- Mark completed tasks as `[x]` via `dossier action=check task_id="T-N.N"`

## Guardrails

- NEVER skip review phases — they are mandatory quality gates
- NEVER commit with unresolved Critical findings
- ALWAYS spawn parallel agents for spec review and code-reviewer (foreground, NOT background) for Wave boundary review
- ALWAYS update tasks.md after each individual task completion (not in batch)
- Call `dossier action=complete` when all tasks are done (user can delay if adding more tasks)
- ALWAYS record decisions and trade-offs via `ledger action=save sub_type=decision`
- ALWAYS use EARS notation for requirements (WHEN/WHILE/WHERE/IF-THEN/SHALL keywords)
- ALWAYS assign unique IDs: FR-N, NFR-N, DEC-N, T-N.N, TS-N.N
- ALWAYS include traceability matrix in design.md
- ALWAYS include `<!-- source: FR-N -->` in test-specs.md Gherkin cases
- Mark `<!-- optional -->` sections as skipped for S-sized tasks
- ALWAYS include "Wave: Closing" tasks (self-review, CLAUDE.md update, test verification) — these trigger auto-complete when all checked

## Troubleshooting

- **Test gate failure (Phase 5 loops)**: Check if tests depend on external state or ordering. Run the failing test in isolation to confirm reproducibility before fixing.
- **Rate limit during parallel agent review**: Reduce concurrency by retrying failed agents sequentially. If persistent, skip to self-review inline and note the degraded review in tasks.md.
