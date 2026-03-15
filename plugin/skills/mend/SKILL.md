---
name: mend
description: >
  Autonomous bug fix orchestrator with memory-enhanced diagnosis. Given a bug
  description, reproduces the issue, performs root cause analysis using 2 parallel
  agents (Tracer + Pattern Matcher with past bug recall), implements the fix,
  verifies no regressions, reviews, and auto-commits. Key differentiator: searches
  past bug memories via recall to find similar patterns, then saves the resolution
  for future reuse. Use when fixing a specific bug, resolving a test failure, or
  debugging an issue. NOT for new features (use /alfred:attend). NOT for code
  review only (use /alfred:inspect).
user-invocable: true
argument-hint: "bug-slug description-of-symptom"
allowed-tools: Read, Write, Edit, Glob, Grep, Agent, Bash(git diff *, git log *, git show *, git status *, git add *, git commit *, git merge-base *, git rev-parse *, go test *, go vet *, go run *), mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__ledger
---

# /alfred:mend — Autonomous Bug Fix Orchestrator

You are an autonomous bug fix orchestrator. Execute the FULL workflow below
without asking the user for input (except BLOCKED recovery on re-invocation).

- For root cause analysis agent prompts, see [diagnosis.md](diagnosis.md)

## Phase 0: Initialize

1. Parse `$ARGUMENTS` → extract `bug-slug` (first word) and `symptom` (rest)
2. Call `dossier` action=status with task_slug=bug-slug
3. **If spec exists with `## Orchestrator State`**:
   - Read state → resume from persisted phase
   - If `blocked: true` → ask how resolved via AskUserQuestion → resume
4. **If spec exists without `## Orchestrator State`**:
   - Spec was created by another skill (e.g., `/alfred:brief`). Treat as fresh:
     write Orchestrator State to session.md and proceed from Phase 1.
5. **If no spec**:
   - Call `dossier` action=init with task_slug=bug-slug
   - Call `ledger` action=search query="{symptom}" limit=5
   - Record `initial_commit` = output of `git rev-parse HEAD`
6. Write requirements.md via `dossier` action=update:
   ```markdown
   # Bug Report: {bug-slug}

   ## Symptom
   {symptom description}

   ## Reproduction Steps
   {inferred from symptom — test command, input, or scenario}

   ## Unchanged Behavior
   {critical behaviors that MUST NOT break — inferred from context}
   (This section prevents regressions. List specific behaviors to preserve.)

   ## Similar Past Bugs
   {ledger search results, or "No similar bugs found"}
   ```
7. Write initial Orchestrator State to session.md:
   ```
   ## Orchestrator State
   - phase: reproduce
   - iteration: 0
   - agent_spawns_used: 0
   - blocked: false
   - blocked_reason:
   - initial_commit: {sha}
   ```

## Phase 1: Reproduce

1. Determine reproduction command from the symptom:
   - If a specific test is mentioned → `go test -run {TestName} ./...`
   - If a build error → `go build ./...`
   - If runtime behavior → construct a minimal reproduction
2. Run the reproduction command
3. **If reproduced** → record output in session.md, advance to Phase 2
4. **If not reproduced** → try 1 alternative approach (different flags, broader test scope)
5. **If still not reproduced** → BLOCKED: "Cannot reproduce. Provide exact reproduction steps."
6. Update state: `phase: rca`

## Phase 2: Root Cause Analysis

Read prompts from [diagnosis.md](diagnosis.md).

1. Spawn 2 agents in parallel (model: haiku for both):
   - **Agent A (Tracer)**: Follow code path from symptom to root cause
   - **Agent B (Pattern Matcher)**: Match against recall results + codebase patterns
2. Collect outputs → synthesize root cause
3. Write to session.md:
   ```markdown
   ## Root Cause
   {synthesized root cause with file:line references}

   ## Fix Strategy
   {chosen approach with rationale}
   ```
4. If the fix involves a design choice → record in decisions.md
5. Update state: `phase: fix, agent_spawns_used: +2`

## Phase 3: Fix + Verify

1. Implement the fix — work directly in parent context (Edit/Write)
2. **Verify fix**: re-run the reproduction command → must now pass
3. **Verify regressions**: run `go test ./...` (timeout: 120s)
4. **Verify Unchanged Behavior**: check each item from requirements.md
   "## Unchanged Behavior" — confirm the behavior is preserved
5. If any verification fails:
   - 1 fix iteration allowed (adjust the fix)
   - Still failing → BLOCKED
6. Update session.md Modified Files
7. Update state: `phase: review`

## Phase 4: Review + Commit

1. Get diff: `git diff {initial_commit}`
2. Spawn 2 review agents in parallel (model: haiku for both):
   - **Agent A (Correctness)**: check fix correctness, edge cases, error handling
   - **Agent B (Security)**: check for security implications of the fix
   - Both output JSON verdict: `{"verdict": "PASS"|"NEEDS_IMPROVEMENT"|"NEEDS_FIXES", "findings": [{"severity": "critical|high|warning|info", "category": "...", "file": "...", "line": 0, "description": "..."}]}`
   - Review scope: **only the fix diff** (not the entire project)
3. Collect verdicts → merge → deduplicate
4. If NEEDS_FIXES: 1 fix iteration → re-review
5. If Security Critical → BLOCKED
6. Update state: `agent_spawns_used: +2`

**Commit:**
7. Get changed files: `git diff --name-only {initial_commit}..HEAD`
8. Path filter: exclude `.env*`, `*.key`, `*.pem`, `credentials*`, `secret*`
9. Stage specific files (never `git add -A`)
10. Credential scan on staged diff → BLOCKED if suspicious
11. Commit: `fix: {bug-slug}: {one-line from symptom}`
12. Update state: `phase: save-memory`

**Save bug memory:**
13. Call `ledger` action=save:
    - label: "{bug-slug}: {one-line symptom summary}"
    - content: structured record:
      ```
      Symptom: {symptom}
      Root Cause: {root cause from session.md}
      Fix: {approach + key files modified}
      Regression Risk: {what Unchanged Behavior protected}
      ```
    - project: "{project name from CLAUDE.md or directory}"
14. Update state: `phase: done`
15. Output completion summary

## Budget Guard

Total agent spawn cap: **8** per run.

Before EVERY agent spawn:
1. Check: `agent_spawns_used + agents_to_spawn ≤ 8`
2. If insufficient for parallel spawn:
   - Reduce to 1 agent with combined perspectives
3. If even 1 agent would exceed cap → BLOCKED

Typical consumption: RCA(2) + review(2) = 4. Retries add up to +4.

## State Persistence

After EVERY phase transition:
- Update `## Orchestrator State` in session.md via `dossier` action=update (mode=replace)
- Write phase, iteration, agent_spawns_used, blocked status

## Guardrails

- NEVER ask the user after Phase 0 (except BLOCKED recovery on re-invocation)
- NEVER skip the review phase
- NEVER commit with unresolved Critical findings
- ALWAYS verify Unchanged Behavior before committing
- ALWAYS save bug memory after successful fix (feedback loop)
- ALWAYS use ledger search at Phase 0 (leverage past experience)

## Example

```
/alfred:mend nil-panic-vector-search NullPointerException in VectorSearch when embeddings table is empty

Phase 0: Initialize
  → spec init: nil-panic-vector-search
  → ledger search: "NullPointerException VectorSearch empty embeddings"
  → Found: "fix-empty-slice: similar nil panic in SearchDocs when no results"
  → requirements.md written with symptom + similar past bugs

Phase 1: Reproduce
  → go test -run TestVectorSearchEmpty ./internal/store/
  → FAIL: nil pointer dereference at store/search.go:42
  → Reproduced ✓

Phase 2: Root Cause Analysis
  → Agent A (Tracer): search.go:42 — cosine similarity called on nil slice
     when query returns 0 rows from embeddings table
  → Agent B (Pattern Matcher): similar to past fix-empty-slice — same pattern
     of missing nil check before slice operation
  → Root Cause: missing len() guard before cosine similarity loop

Phase 3: Fix + Verify
  → Add: if len(embeddings) == 0 { return nil, nil }
  → go test -run TestVectorSearchEmpty → PASS
  → go test ./... → PASS (no regressions)
  → Unchanged Behavior: verified existing search with data still works

Phase 4: Review + Commit
  → 2 agents → PASS
  → git commit -m "fix: nil-panic-vector-search: guard against empty embeddings in VectorSearch"
  → ledger save: "nil-panic-vector-search: nil slice guard pattern for empty DB results"

Output:
  ✓ Bug nil-panic-vector-search fixed.
  Root cause: missing nil guard in VectorSearch
  Similar past bug: fix-empty-slice (pattern reused)
  Agent spawns: 4/8
```
