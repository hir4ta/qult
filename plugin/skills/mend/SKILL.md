---
name: mend
description: >
  Use when fixing a specific bug, resolving a test failure, or debugging an issue.
  NOT for new features (use /alfred:attend). NOT for code review only
  (use /alfred:inspect).
user-invocable: true
argument-hint: "bug-slug description-of-symptom"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git diff *, git log *, git show *, git status *, git add *, git commit *, git merge-base *, git rev-parse *, go test *, go vet *, go run *), mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__ledger
---

# /alfred:mend — Autonomous Bug Fix Orchestrator

Execute the FULL workflow below without asking the user for input (except
BLOCKED recovery on re-invocation). No sub-agents are spawned.

This skill follows the **invariant Spec-Driven Development Flow** (see CLAUDE.md):
Spec > Wave > Task. Self-review is mandatory for all sizes. Call `dossier action=complete`
when the fix is verified.

## Red Flags

These thought patterns signal you are about to violate this skill's rules:

- "I already know the root cause" → This is confirmation bias. Follow the 2-perspective analysis.
- "Let me just try this quick fix" → Symptom fixes mask root causes. Diagnose first.
- "The regression tests aren't needed, the fix is isolated" → Isolated fixes have unexpected side effects. Verify.
- "3 fix attempts failed but I'll try one more" → Stop. Reassess the architecture. The problem is deeper.

## Phase 0: Initialize

1. Parse `$ARGUMENTS` → extract `bug-slug` (first word) and `symptom` (rest)
2. Call `dossier` action=status with task_slug=bug-slug
3. **If spec exists with `## Orchestrator State`**: resume from persisted phase
4. **If no spec**:
   - Call `dossier` action=init with task_slug=bug-slug
   - Call `ledger` action=search query="{symptom}" limit=5
   - Record `initial_commit` = `git rev-parse HEAD`
5. Write requirements.md with symptom, reproduction steps, unchanged behavior, similar past bugs
6. Write initial Orchestrator State to session.md

## Phase 1: Reproduce

1. Determine reproduction command from the symptom
2. Run the reproduction command
3. **If reproduced** → record output, advance to Phase 2
4. **If not reproduced** → try 1 alternative → still not → BLOCKED
5. **Update session.md**: mark reproduce as done

## Phase 2: Root Cause Analysis (inline, 2 perspectives)

Analyze the bug from 2 perspectives in a single structured response:

### Perspective 1: Tracer
- Follow the code path from symptom to root cause
- Identify the exact file:line where the bug manifests
- Trace data flow to find where incorrect state originates

### Perspective 2: Pattern Matcher
- Compare against ledger search results (similar past bugs)
- Look for known anti-patterns in the codebase
- Check if the same fix pattern applies

### Synthesis
- Synthesize root cause with file:line references
- Choose fix strategy with rationale
- Record in session.md and decisions.md if design choice involved
- **Update session.md**: mark RCA as done

## Phase 3: Fix + Verify

1. Implement the fix directly (Edit/Write)
2. **Verify fix**: re-run reproduction command → must pass
3. **Verify regressions**: `go test ./...` (timeout: 120s)
4. **Verify Unchanged Behavior**: check each item from requirements.md
5. If any verification fails: 1 fix iteration → still failing → BLOCKED
6. **Update session.md**: mark fix as done, update Modified Files

## Phase 4: Review + Commit

1. Get diff: `git diff {initial_commit}`
2. **Review inline from 3 perspectives**:
   - **Correctness**: fix is correct, edge cases handled, error handling
   - **Security**: no security implications from the fix
   - **Regression**: changes don't break existing behavior
3. If issues found: 1 fix iteration → re-review
4. If Security Critical → BLOCKED

**Commit:**
5. Stage specific files (never `git add -A`)
6. Credential scan on staged diff → BLOCKED if suspicious
7. Commit: `fix: {bug-slug}: {one-line from symptom}`
8. **MUST complete**: `dossier action=complete task_slug={bug-slug}`

**Save bug memory:**
9. Call `ledger` action=save with structured record (symptom, root cause, fix, regression risk)
10. **Update session.md**: mark all steps as done

## State Persistence

After EVERY phase transition:
- Update session.md via `dossier` action=update (mode=replace)
- Mark completed Next Steps as `[x]` immediately (dashboard UX)

## Guardrails

- NEVER ask the user after Phase 0 (except BLOCKED recovery)
- NEVER skip the review phase
- NEVER commit with unresolved Critical findings
- NEVER spawn sub-agents — all analysis is inline (rate limit prevention)
- ALWAYS verify Unchanged Behavior before committing
- ALWAYS save bug memory after successful fix
- ALWAYS call `dossier action=complete` at the end
- ALWAYS update session.md after each phase (not in batch)

## Troubleshooting

- **Cannot reproduce the bug**: Ask the user for exact reproduction steps, environment details, and input data. Check if the bug is environment-specific or requires particular state setup.
- **Tests are flaky**: Isolate the specific failing test and run it repeatedly (`go test -run TestName -count=10`). Address non-determinism before attempting a fix.
- **Fix introduces new test failures**: Run the full test suite (`go test ./...`) before committing. If new failures appear, check if the fix changed shared state or interfaces that other tests depend on.
