---
name: survey
description: >
  Reverse-engineer spec files from existing code. Analyzes code structure,
  dependencies, and business logic to generate requirements.md, design.md,
  decisions.md, and session.md with confidence annotations. Output feeds directly
  into the normal spec management flow (/alfred:attend, /alfred:inspect). Use when
  onboarding to an existing codebase, documenting undocumented code, or preparing
  specs before modifying legacy code. NOT for new feature design (use /alfred:brief).
  NOT for implementation (use /alfred:attend).
user-invocable: true
argument-hint: "task-slug [path/to/package | project]"
allowed-tools: Read, Glob, Grep, Agent, Bash(go doc *, go list *, wc *, find *), mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__ledger
---

# /alfred:survey — Reverse Engineering Spec Generator

You are a reverse engineering analyst. Analyze existing code and produce spec files
that describe what the code does, with confidence annotations distinguishing facts
from inferences.

- For analysis agent prompts, see [analysis.md](analysis.md)

## Phase 0: Scope & Initialize

1. Parse `$ARGUMENTS` → extract `task-slug` (first word) and `scope` (rest)
2. Determine scope:
   - If scope is a file path (contains `/` or `.`) → **package scope** (that directory only)
   - If scope is `project` or omitted → **project scope** (entire project)
   - Validate the path exists if specified
3. Gather file inventory:
   - Package scope: `find {path} -name "*.go" | wc -l`
   - Project scope: `find . -name "*.go" -not -path "*/vendor/*" | wc -l`
   - If project scope and >50 Go files → warn: "Large codebase. Consider targeting
     a specific package for better results."
4. Call `dossier` action=init with task_slug=task-slug,
   description="Reverse-engineered spec for {scope}"
5. Call `ledger` action=search query="{scope} architecture design" limit=3
   (check for existing knowledge about this code)
6. Read CLAUDE.md and README.md if they exist (project context)

## Phase 1: Analysis

Read prompts from [analysis.md](analysis.md). Agent count depends on scope.

**Package scope (2 agents in parallel, model: haiku):**
- Agent A (Structure Analyst): types, interfaces, exported functions, entry points
- Agent B (Dependency Mapper): imports, data flow, shared types

**Project scope (staggered, model: haiku):**
- **Batch 1**: Agent A (Structure Analyst) + Agent B (Dependency Mapper) in parallel
- **Batch 2**: Agent C (Business Logic Inferrer) with Batch 1 outputs as context
  — goals, requirements from README/CLAUDE.md/tests/comments

Each agent outputs structured JSON (see analysis.md for format).

Update state: `agent_spawns_used: +2 or +3`

## Phase 2: Synthesis

Spawn 1 Mediator agent with all analysis outputs.

The Mediator produces content for all 4 spec files with confidence annotations:
- **Confidence scale** (use `<!-- confidence: N -->` HTML comments):
  - 9-10: Code-derived facts (types, interfaces, imports, function signatures)
  - 7-8: Test-derived requirements (behavior verified by existing tests)
  - 5-7: Document-derived goals (from README, CLAUDE.md, comments)
  - 3-5: Inferred business logic (no explicit evidence in code)

The parent orchestrator writes spec files — the Mediator does NOT call spec tool.

Update state: `agent_spawns_used: +1`

## Phase 3: Write & Validate

1. Write all 4 files via `dossier` action=update (mode=replace):

   **requirements.md:**
   ```markdown
   # Requirements: {task-slug} (Reverse-Engineered)

   ## Goal <!-- confidence: N -->
   {inferred goals from business logic analysis}

   ## Success Criteria <!-- confidence: N -->
   {derived from existing test assertions and documented behavior}
   - [ ] {criterion 1 — from test}
   - [ ] {criterion 2 — from docs}

   ## Current Capabilities <!-- confidence: N -->
   {what the code currently does — factual, high confidence}

   ## Out of Scope
   {explicitly noted limitations or missing features}

   ## Confidence Summary
   - Code-derived (9-10): N items
   - Test-derived (7-8): N items
   - Doc-derived (5-7): N items
   - Inferred (3-5): N items
   ```

   **design.md:**
   ```markdown
   # Design: {task-slug} (Reverse-Engineered)

   ## Architecture <!-- confidence: N -->
   {from Structure Analyst — package hierarchy, components, relationships}

   ## Data Flow <!-- confidence: N -->
   {from Dependency Mapper — how data moves between components}

   ## Key Interfaces <!-- confidence: N -->
   {exported types, interfaces, function signatures — high confidence}

   ## Technical Decisions <!-- confidence: N -->
   {inferred from code patterns — why certain approaches were chosen}
   ```

   **decisions.md:**
   ```markdown
   # Decisions: {task-slug} (Reverse-Engineered)

   ## D1: {pattern observed}
   - **Observed**: {what the code does}
   - **Inferred Reason**: {why this approach was likely chosen}
   - **Confidence**: {N}/10
   - **Evidence**: {file:line references}
   ```

   **session.md:**
   ```markdown
   # Session: {task-slug}

   ## Status: reverse-complete

   ## Summary
   Reverse-engineered spec generated from {scope}.
   {file count} files analyzed, {agent count} agents used.

   ## Low-Confidence Items
   {list items with confidence ≤ 5 that need human validation}

   ## Recommended Next Steps
   - Review low-confidence items and adjust
   - Run `/alfred:attend {task-slug}` to implement changes
   - Run `/alfred:inspect` to validate spec accuracy
   ```

2. Structural validation (lightweight):
   - Goal section non-empty
   - At least 1 success criterion
   - Architecture section non-empty
3. Output summary to user

## Output

Display a summary:
```
✓ Reverse-engineered spec for {scope}
  Spec: .alfred/specs/{task-slug}/
  Files analyzed: {N}
  Agents used: {N}/{max}

  Confidence breakdown:
  - Code-derived (9-10): {N} items
  - Test-derived (7-8): {N} items
  - Doc-derived (5-7): {N} items
  - Inferred (≤5): {N} items ← review these

  Next: /alfred:attend {task-slug} or /alfred:inspect
```

## Budget Guard

Total agent spawn cap: **6** per run.

- Package scope: 2 (analysis) + 1 (synthesis) = 3 typical
- Project scope: 3 (analysis) + 1 (synthesis) = 4 typical
- Buffer for retries: +2

## Guardrails

- NEVER modify source code (this is a read-only analysis skill)
- NEVER commit anything
- ALWAYS annotate every section with confidence scores
- ALWAYS flag items with confidence ≤ 5 in session.md Low-Confidence Items
- ALWAYS include file:line references as evidence for claims
- Inferred business logic MUST be clearly labeled as inference, not fact
- When recall returns existing knowledge, cross-reference with code analysis

## Example

```
/alfred:survey analyze-store internal/store

Phase 0: Scope & Initialize
  → Package scope: internal/store/
  → 8 Go files (excluding tests)
  → spec init: analyze-store
  → ledger search: "internal/store architecture" → found 2 memories

Phase 1: Analysis (2 agents)
  → Agent A (Structure): Store struct, 15 exported methods, SQLite backend,
     schema migration system, 3 tables (records, embeddings, schema_version)
  → Agent B (Dependencies): imports ncruces/go-sqlite3, used by mcpserver +
     hooks, data flows: records↔embeddings via source_id FK

Phase 2: Synthesis (1 agent)
  → Mediator produces 4 spec files with confidence annotations
  → Code-derived: 12 items (confidence 9-10)
  → Test-derived: 5 items (confidence 7-8)
  → Inferred: 3 items (confidence 4-5)

Phase 3: Write & Validate
  → 4 spec files written
  → 3 low-confidence items flagged

Output:
  ✓ Reverse-engineered spec for internal/store
  Spec: .alfred/specs/analyze-store/
  Files analyzed: 8
  Agents used: 3/6

  Confidence breakdown:
  - Code-derived (9-10): 12 items
  - Test-derived (7-8): 5 items
  - Inferred (≤5): 3 items ← review these

  Next: /alfred:attend analyze-store or /alfred:inspect
```
