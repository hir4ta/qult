---
name: tdd
description: >
  Autonomous TDD orchestrator — runs full red/green/refactor cycles with automatic
  test pattern memory and coverage tracking. Given a feature description, creates
  failing tests first, implements minimal code to pass, refactors, and iterates.
  Searches past test patterns via ledger for reuse, saves new patterns for future
  sessions. Use when wanting test-driven implementation, "build with tests first",
  or /alfred:tdd. NOT for bug fixes (use /alfred:mend). NOT for code without tests
  (just ask directly or use /alfred:attend).
user-invocable: true
argument-hint: "task-slug feature-description"
allowed-tools: Read, Write, Edit, Glob, Grep, Agent, Bash(git diff *, git log *, git show *, git status *, git add *, git commit *, git merge-base *, git rev-parse *, go test *, go vet *, go run *, npm test *, pytest *, cargo test *), mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__ledger, mcp__plugin_alfred_alfred__roster
---

# /alfred:tdd — Autonomous TDD Orchestrator

You are an autonomous TDD orchestrator. Execute the FULL workflow below
without asking the user for input (except BLOCKED recovery on re-invocation).

- For TDD cycle details and gate criteria, see [cycle.md](cycle.md)

## Phase 0: Initialize

1. Parse `$ARGUMENTS` → extract `task-slug` (first word) and `description` (rest)
2. Call `dossier` action=status with task_slug
3. **If spec exists with `## Orchestrator State`**:
   - Read state → resume from persisted phase/cycle
   - If `blocked: true` → ask via AskUserQuestion → resume
4. **If spec exists without Orchestrator State**:
   - Spec was created by another skill. Proceed from Phase 1.
5. **If no spec**:
   - Call `dossier` action=init with task_slug
6. Record `initial_commit` = output of `git rev-parse HEAD`
7. Call `ledger` action=search query="{description} test pattern" limit=5
   - Record any relevant test patterns for reuse in Phase 1
8. Analyze the codebase to determine:
   - Test framework in use (go test, pytest, jest, cargo test, etc.)
   - Test file naming convention (`*_test.go`, `test_*.py`, `*.test.ts`, etc.)
   - Existing test patterns and helpers
9. Write requirements.md via `dossier` action=update:
   ```markdown
   # Requirements: {task-slug}

   ## Goal
   {description}

   ## Test Cases (TDD Plan)
   1. {first test case — most fundamental behavior}
   2. {second test case — next logical step}
   3. {third test case — edge case or error path}
   ...

   ## Past Patterns (from ledger)
   {relevant test patterns found, or "None found"}
   ```
10. Write initial Orchestrator State to session.md:
    ```
    ## Orchestrator State
    - phase: red
    - cycle: 1
    - total_cycles: {N from test case count}
    - iteration: 0
    - agent_spawns_used: 0
    - blocked: false
    - blocked_reason:
    - initial_commit: {sha}
    - coverage_start: {current coverage % or "unknown"}
    ```

## Phase 1: RED — Write Failing Test

Follow [cycle.md](cycle.md) § RED phase.

1. Read the current test case from the TDD Plan (cycle N)
2. Write a test that:
   - Tests the expected behavior described in the test case
   - Is minimal and focused on ONE behavior
   - Uses existing test helpers/patterns where available
   - Follows the project's test naming convention
3. Run the test suite → **the new test MUST fail**
4. Record WHY this test should fail:
   ```markdown
   ### Cycle {N}: {test case name}
   RED: Test `TestXxx` fails because {reason}
   ```
5. **Gate**: If the test passes (already implemented), skip to next cycle
6. **Gate**: If the test fails for wrong reason (compilation error, wrong assertion),
   fix the test until it fails for the RIGHT reason
7. Update state: `phase: green`

## Phase 2: GREEN — Minimal Implementation

Follow [cycle.md](cycle.md) § GREEN phase.

1. Write the MINIMUM code to make the failing test pass
   - Do NOT add extra functionality
   - Do NOT refactor yet
   - Do NOT handle edge cases beyond what the test requires
2. Run the test suite → ALL tests must pass (new + existing)
3. **Gate**: If tests fail, fix implementation (max 2 iterations)
4. **Gate**: If existing tests broke, fix without changing the new test
5. Record:
   ```markdown
   GREEN: `TestXxx` passes. Implementation: {brief description}
   ```
6. Update state: `phase: refactor`

## Phase 3: REFACTOR — Clean Up

Follow [cycle.md](cycle.md) § REFACTOR phase.

1. Review the code written in GREEN phase:
   - Remove duplication
   - Improve naming
   - Extract helpers if pattern repeats 3+ times
   - Simplify logic
2. Run the test suite → ALL tests must still pass
3. **Gate**: If any test fails after refactoring, revert the refactor change
4. Record:
   ```markdown
   REFACTOR: {what was improved, or "No refactoring needed"}
   ```
5. Update state: `phase: verify`

## Phase 4: VERIFY — Static Analysis

1. Run static analysis:
   - Go: `go vet ./...`
   - Additional linters if configured (staticcheck, etc.)
2. Run full test suite to confirm no regressions
3. Measure coverage delta if possible:
   - Go: `go test -cover ./...` and extract percentage
4. Record:
   ```markdown
   VERIFY: vet clean, coverage {X}% (+{delta}%)
   ```
5. Update state: `phase: record`

## Phase 5: RECORD — Save Pattern to Memory

1. Call `ledger` action=save with:
   - label: "tdd-pattern: {task-slug} cycle {N}: {test case name}"
   - content:
     ```
     Test Pattern: {test case name}
     Framework: {go test / pytest / etc.}
     Pattern: {table-driven / mock / integration / etc.}
     Test Code Summary: {key assertions and setup}
     Implementation Approach: {how the code was structured to pass}
     Coverage Impact: +{delta}%
     ```
   - project: "{project name}"
2. Update session.md TDD Progress:
   ```markdown
   ## TDD Progress
   - Cycle: {N}/{total}
   - Tests: {pass} pass, {fail} fail
   - Coverage: {X}% (+{delta}% from start)

   ### Cycle History
   1. [x] {test case 1} — red({time}) green({time}) refactor({time}) cov:+{delta}%
   2. [x] {test case 2} — ...
   3. [ ] {test case 3} — (next)
   ```
3. Update state: `phase: iterate`

## Phase 6: ITERATE — Next Cycle or Complete

1. If more test cases remain in the TDD Plan:
   - Increment cycle
   - Update state: `phase: red, cycle: {N+1}`
   - Return to Phase 1
2. If all test cases complete → Phase 7

## Phase 7: COMPLETE — Final Verification and Commit

1. Run full test suite: all tests must pass
2. Run static analysis: must be clean
3. If linked to an epic, update via `roster`:
   - Call `roster` action=status to check if task is in an epic
   - If yes, the PreCompact hook will auto-sync status
4. Get changed files: `git diff --name-only {initial_commit}..HEAD`
5. Path filter: exclude `.env*`, `*.key`, `*.pem`, `credentials*`, `secret*`
6. Stage specific files: `git add <file1> <file2> ...`
7. Credential scan on staged diff → BLOCKED if suspicious
8. Commit: `feat: {task-slug}: TDD implementation ({N} cycles, coverage +{delta}%)`
9. Save completion memory via `ledger` action=save:
   - label: "tdd-complete: {task-slug}"
   - content: full TDD Progress section from session.md
10. Update state: `phase: done`
11. Output completion summary:
    ```
    TDD complete for '{task-slug}'.
    Cycles: {N}/{total}
    Tests written: {count}
    Coverage: {start}% -> {end}% (+{delta}%)
    Patterns saved: {N}
    Agent spawns: {used}/{cap}
    ```

## Budget Guard

Total agent spawn cap: **4** per run.

TDD is primarily a sequential, single-agent workflow.
Agents are only used for:
- Phase 0: ledger search (no agent needed — direct tool call)
- Final review if needed (spawn 1 agent with combined perspective)

Before any agent spawn:
1. Check: `agent_spawns_used + 1 ≤ 4`
2. If exceeded → skip agent review, proceed with self-review

## State Persistence

After EVERY phase transition:
- Update `## Orchestrator State` in session.md via `dossier` action=update (mode=replace)
- Write phase, cycle, total_cycles, iteration, agent_spawns_used, blocked status, coverage

## Guardrails

- NEVER write implementation code before the failing test (RED before GREEN)
- NEVER add functionality beyond what the current test requires
- NEVER skip the REFACTOR phase — even if "nothing to refactor"
- NEVER skip VERIFY — static analysis catches what tests miss
- ALWAYS save test patterns to ledger (builds reusable knowledge)
- ALWAYS search ledger at Phase 0 (leverage past patterns)
- ALWAYS run ALL tests after each phase (catch regressions early)
- ALWAYS record RED failure reason (documents intent)

## Example

```
/alfred:tdd epic-progress Epic progress calculation with dependency validation

Phase 0: Initialize
  → spec init: epic-progress
  → ledger search: "epic progress test pattern" → found: "topological sort test with cycles"
  → Test Cases: 1. empty epic  2. single task  3. dependency chain  4. cycle detection  5. progress %

Phase 1-5 Cycle 1: Empty Epic
  RED: TestProgressEmpty fails — Progress() not implemented
  GREEN: return 0, 0, nil → passes
  REFACTOR: no changes needed
  VERIFY: vet clean, coverage 45% (+2.1%)
  RECORD: saved "tdd-pattern: epic-progress cycle 1: empty epic"

Phase 1-5 Cycle 2: Single Task
  RED: TestProgressSingleCompleted fails — no task tracking
  GREEN: count completed tasks → passes
  REFACTOR: extract countByStatus helper
  VERIFY: vet clean, coverage 48% (+3.0%)
  RECORD: saved pattern

... (cycles 3-5) ...

Phase 7: Complete
  → go test ./... → PASS
  → go vet ./... → clean
  → commit: "feat: epic-progress: TDD implementation (5 cycles, coverage +12.4%)"
  → ledger save: completion summary

TDD complete for 'epic-progress'.
Cycles: 5/5
Tests written: 8
Coverage: 45% -> 57.4% (+12.4%)
Patterns saved: 5
Agent spawns: 0/4
```

## Troubleshooting

- **Test framework not detected**: Specify the test command explicitly in the feature description, or ensure the project has recognizable test files (`*_test.go`, `test_*.py`, `*.test.ts`).
- **Infinite red loop (test keeps failing after GREEN)**: The test design may be flawed. Revisit the test case — ensure it tests observable behavior, not implementation details. Simplify the assertion.
- **Coverage measurement unavailable**: Skip coverage tracking and focus on passing tests. Update the Orchestrator State to note `coverage_start: unknown` and omit delta reporting.
