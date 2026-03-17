---
name: survey
description: >
  Reverse-engineer spec files from existing code. Analyzes code structure,
  dependencies, and business logic to generate requirements.md, design.md,
  decisions.md, and session.md with confidence annotations. All analysis is
  inline (no sub-agents). Output feeds directly into the normal spec management
  flow (/alfred:attend, /alfred:inspect). Use when onboarding to an existing
  codebase, documenting undocumented code, or preparing specs before modifying
  legacy code. NOT for new feature design (use /alfred:brief). NOT for
  implementation (use /alfred:attend).
user-invocable: true
argument-hint: "task-slug [path/to/package | project]"
allowed-tools: Read, Glob, Grep, Bash(go doc *, go list *, wc *, find *), mcp__plugin_alfred_alfred__dossier, mcp__plugin_alfred_alfred__ledger
---

# /alfred:survey — Reverse Engineering Spec Generator

Analyze existing code and produce spec files that describe what the code does,
with confidence annotations distinguishing facts from inferences.
All analysis is inline — no sub-agents are spawned.

## Phase 0: Scope & Initialize

1. Parse `$ARGUMENTS` → extract `task-slug` and `scope`
2. Determine scope:
   - Path with `/` or `.` → **package scope** (that directory)
   - `project` or omitted → **project scope** (entire project)
3. Gather file inventory
4. Call `dossier` action=init
5. Call `ledger` action=search query="{scope} architecture design" limit=3
6. Read CLAUDE.md and README.md if they exist

## Phase 1: Analysis (inline, 3 perspectives)

Analyze the code from 3 perspectives in a single structured pass:

### Perspective 1: Structure Analyst
- Types, interfaces, exported functions, entry points
- Package hierarchy and component relationships
- File organization patterns

### Perspective 2: Dependency Mapper
- Imports and external dependencies
- Data flow between components
- Shared types and interfaces

### Perspective 3: Business Logic Inferrer
- Goals and requirements from README/CLAUDE.md/tests/comments
- Behavioral patterns from test assertions
- Design decisions inferred from code patterns

## Phase 2: Write Spec Files (per-file with review)

Write each file, review from 3 perspectives, then move to the next.
**Update session.md after each file is completed.**

### 2a. requirements.md
- Write with confidence annotations
- Review: Are goals accurate? Are success criteria from actual tests?
- **Update session.md**: mark requirements as done

### 2b. design.md
- Write architecture, data flow, key interfaces
- Review: Does architecture description match actual code structure?
- **Update session.md**: mark design as done

### 2c. decisions.md
- Write observed decisions with inferred reasoning
- Review: Are inferences clearly labeled? Evidence cited?
- **Update session.md**: mark decisions as done

### 2d. session.md
- Write summary with low-confidence items flagged
- Status: reverse-complete

**Confidence scale** (use `<!-- confidence: N -->` HTML comments):
- 9-10: Code-derived facts (types, interfaces, imports)
- 7-8: Test-derived requirements (verified by existing tests)
- 5-7: Document-derived goals (from README, CLAUDE.md)
- 3-5: Inferred business logic (no explicit evidence)

## Phase 3: Output

```
Reverse-engineered spec for {scope}
  Spec: .alfred/specs/{task-slug}/
  Files analyzed: {N}

  Confidence breakdown:
  - Code-derived (9-10): {N} items
  - Test-derived (7-8): {N} items
  - Doc-derived (5-7): {N} items
  - Inferred (<=5): {N} items — review these

  Next: /alfred:attend {task-slug} or /alfred:inspect
```

## Guardrails

- NEVER modify source code (read-only analysis)
- NEVER commit anything
- NEVER spawn sub-agents — all analysis is inline (rate limit prevention)
- ALWAYS annotate every section with confidence scores
- ALWAYS flag items with confidence <= 5 in session.md
- ALWAYS include file:line references as evidence
- ALWAYS update session.md after each file (dashboard UX)
- Label inferred logic clearly as inference, not fact

## Troubleshooting

- **Codebase too large**: Narrow the scope to a specific package or directory (`/alfred:survey task-slug internal/store`). Project-wide surveys on large codebases may hit context limits.
- **Binary/generated files detected**: Skip them. Focus on source files with meaningful business logic. Generated files (`.pb.go`, `_gen.go`, `_string.go`) add noise without insight.
- **No clear entry point found**: Ask the user which files or packages to start from. Check for `main.go`, `cmd/`, or test files as alternative entry points.
