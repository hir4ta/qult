---
name: brief
description: >
  Structured spec generation with parallel multi-agent review per file.
  Creates 7 spec files (requirements, design, tasks, test-specs, decisions, research, session)
  in .alfred/specs/ using EARS notation, traceability IDs, and Gherkin test specs.
  Each file is reviewed by 3 parallel agents before moving to the next.
  After all files, user approves via `alfred dashboard`.
  Use when starting a new task, organizing a design, planning before implementation,
  or wanting a structured development plan. NOT for divergent brainstorming
  (use /alfred:salon). NOT for autonomous implementation (use /alfred:attend).
user-invocable: true
argument-hint: "task-slug [description]"
allowed-tools: Read, Edit, Glob, Grep, Agent, AskUserQuestion, WebSearch, WebFetch, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier
context: current
---

# /alfred:brief — Spec Generator with Staged Review

Generate a structured spec through iterative file-by-file creation with
parallel multi-agent review after each file.

## Spec v2 File System (7 files)

| File | Purpose | ID Prefix |
|------|---------|-----------|
| requirements.md | EARS requirements + NFR + acceptance criteria | FR-N, NFR-N |
| design.md | Architecture + data models + API + traceability matrix | — |
| tasks.md | Wave-based task decomposition + parallel markers | T-N.N |
| test-specs.md | Gherkin test cases + edge cases + coverage matrix | TS-N.N |
| decisions.md | ADR format with reversibility analysis | DEC-N |
| research.md | Investigation + gap analysis + implementation options | — |
| session.md | Status + next steps + orchestrator state | — |

## Core Principle
Each spec file is written, then reviewed by 3 parallel agents (Architect, Devil's
Advocate, Researcher) before moving to the next. After all files are complete,
the user approves via `alfred dashboard`.

## Steps

### 1. [WHAT] Parse $ARGUMENTS
- task-slug (required): URL-safe identifier
- description (optional): brief summary
- If no arguments, confirm via AskUserQuestion

### 2. [CHECK] Call `dossier` with action=status
- If active spec exists for this slug → resume mode (see Resume Mode below)
- If no spec → creation mode (continue)

### 3. [INIT] Create spec and gather requirements
1. Call `dossier` action=init to create the spec directory (creates all 7 template files)
2. Call `knowledge` to search for relevant best practices
3. Ask user (max 3 questions):
   - What is the goal? (one sentence)
   - What does success look like? (measurable criteria)
   - What is explicitly out of scope?

### 4. [RESEARCH] Write and review research.md

**Write**: Call `dossier` action=update, file=research.md with:
- Existing code analysis (scan relevant files)
- Gap analysis (current state → required state → gaps)
- Implementation options with effort/risk assessment
- Risks & unknowns
- Confidence scores via `<!-- confidence: N | source: TYPE -->`

**Review** (3 parallel agents):
Spawn 3 agents simultaneously via Agent tool. Each reads research.md and returns findings.
- **Agent 1 — Architect**: Is the existing code analysis complete? Missing integration points?
- **Agent 2 — Devil's Advocate**: Are risks understated? Hidden unknowns? Bias toward one option?
- **Agent 3 — Researcher**: Existing patterns in codebase to reuse? Libraries available?

**Fix**: Collect findings from all 3 agents. Apply fixes, rewrite research.md if needed.

### 5. [REQUIREMENTS] Write and review requirements.md

**Write**: Call `dossier` action=update, file=requirements.md with:
- Goal and user stories (US-N)
- Functional requirements in **EARS notation** (FR-N with unique IDs):
  - Ubiquitous: `The {system} SHALL {response}.`
  - Event-Driven: `WHEN {trigger}, the {system} SHALL {response}.`
  - State-Driven: `WHILE {state}, the {system} SHALL {response}.`
  - Optional: `WHERE {feature}, the {system} SHALL {response}.`
  - Unwanted: `IF {condition}, THEN the {system} SHALL {response}.`
  - Complex: combine sparingly, prefer decomposition
- Acceptance criteria in Given/When/Then format (AC-N.N)
- Non-functional requirements (NFR-N) with measurable targets
- Confidence scores with source: `<!-- confidence: N | source: user/code/inference/assumption -->`

**Review** (3 parallel agents):
- **Agent 1 — Architect**: Are EARS patterns correct? Measurable success criteria? Missing constraints?
- **Agent 2 — Devil's Advocate**: Scope too broad? Missing edge cases? Unrealistic criteria?
- **Agent 3 — Researcher**: Prior art? Existing patterns that inform requirements?

**Fix**: Apply fixes, rewrite if needed.

### 6. [DESIGN] Write and review design.md

**Write**: Call `dossier` action=update, file=design.md with:
- Architecture overview, component design with **interfaces** (function signatures)
- **Data models** (SQL schema or struct definitions)
- **API contracts** (endpoints + request/response + error codes)
- **Requirements traceability matrix**: Req ID → Component → Task ID → Test ID
- Migration strategy (if applicable)
- Tech decisions quick reference (→ decisions.md #DEC-N)

**Review** (3 parallel agents):
- **Agent 1 — Architect**: Sound architecture? Clear interfaces? Missing components?
- **Agent 2 — Devil's Advocate**: What could go wrong? Hidden complexity? Underestimated effort?
- **Agent 3 — Researcher**: Codebase patterns to reuse? Consistency with existing design?

**Fix**: Apply fixes, rewrite if needed.

### 7. [TASKS] Write and review tasks.md

**Write**: Call `dossier` action=update, file=tasks.md with:
- Summary (total count, size breakdown, parallel-safe count)
- Tasks organized into **Waves** (Foundation → Core → Edge Cases → Polish)
- Each task: T-N.N [S/M/L/XL] (P) description
  - `_Requirements: FR-N | Depends: T-N.N | Files: path_`
- Size legend (S/M/L/XL definitions)
- Dependency graph (ASCII)

**Review** (3 parallel agents):
- **Agent 1 — Architect**: Is wave ordering correct? Dependencies valid? Effort estimates reasonable?
- **Agent 2 — Devil's Advocate**: Missing tasks? Underestimated complexity? Parallelism conflicts?
- **Agent 3 — Researcher**: Similar tasks done before? Patterns to reuse?

**Fix**: Apply fixes, rewrite if needed.

### 8. [TEST-SPECS] Write and review test-specs.md

**Write**: Call `dossier` action=update, file=test-specs.md with:
- **Coverage matrix**: Req ID → Test IDs → Type → Priority (P0/P1/P2) → Status
- **Test cases in Gherkin**: Each with `<!-- source: FR-N -->` annotation
  - Map EARS: WHILE→Given, WHEN→When, SHALL→Then
- **Edge case matrix**: Scenario → Input → Expected → Req
- **Boundary values** table (if applicable)
- **Test data & fixtures** (if applicable)
- **Security test cases** (if applicable)

**Review** (3 parallel agents):
- **Agent 1 — Architect**: Coverage complete? All FRs have tests? Happy + error paths?
- **Agent 2 — Devil's Advocate**: Missing edge cases? Boundary values? Security scenarios?
- **Agent 3 — Researcher**: Existing test patterns in codebase? Test utilities available?

**Fix**: Apply fixes, rewrite if needed.

### 9. [DECISIONS] Write and review decisions.md

**Write**: Call `dossier` action=update, file=decisions.md with:
- All decisions in **ADR format** with unique DEC-N IDs:
  - Status (Proposed/Accepted), Context, Chosen, Alternatives, Rationale
  - Consequences, **Reversibility** (Low/Medium/High), **Revisit When**
- Include decisions from research.md option selection
- Unresolved conflicts flagged for user decision

**Review** (3 parallel agents):
- **Agent 1 — Architect**: Consistent with design? Missing decisions?
- **Agent 2 — Devil's Advocate**: Faulty assumptions? Reversibility correctly assessed?
- **Agent 3 — Researcher**: Aligned with established patterns? Historical precedent?

**Fix**: Apply fixes, rewrite if needed.

### 10. [SESSION] Write session.md

**Write**: Call `dossier` action=update, file=session.md with:
- Status: active
- Currently Working On
- Next Steps: derive from **tasks.md T-IDs** (as unchecked items referencing T-N.N)
- Recent Decisions (last 3)
- Blockers

No review needed for session.md — it's a status file.

### 11. [OUTPUT] Summary to user

```
Spec created for '{task-slug}'.

Deliberation: 3 perspectives applied per file (Architect, Devil's Advocate, Researcher)
- research.md ✓ (reviewed)
- requirements.md ✓ (reviewed)
- design.md ✓ (reviewed)
- tasks.md ✓ (reviewed)
- test-specs.md ✓ (reviewed)
- decisions.md ✓ (reviewed)
- session.md ✓

Confidence: requirements avg X.X, design avg X.X
[Items with confidence ≤ 5 and source=assumption listed here]

[If unresolved conflicts exist:]
Please decide on these open questions:
1. <conflict description> — Option A vs Option B
```

### 12. [APPROVAL GATE] User reviews in dashboard

1. Add `## Review Status\npending` to session.md
2. Tell the user:
   ```
   Spec ready for your review.
   Run `alfred dashboard` → Tasks tab → select '{task-slug}' → review spec files.
   Approve or add comments, then tell me.
   ```
3. **STOP and wait** — do not proceed until the user confirms.
4. When user responds, call `dossier` action=review to check:
   - `approved` → done
   - `changes_requested` → read comments, apply fixes, go back to step 12
   - `pending` → remind user to review in dashboard

## Resume Mode (from Step 2)

If an active spec already exists:
1. Call `dossier` action=status to get current session state
2. Read spec files in recovery order: session.md → requirements.md → design.md → tasks.md
3. Present summary: "Resuming task '{slug}'. Last position: {current_position}."
4. Ask: "Continue from here, or update the plan?"

## Guardrails

- Do NOT skip per-file review — each file MUST be reviewed by parallel agents before moving to the next
- Do NOT leave decisions.md empty — record ALL deliberation outcomes
- Do NOT create tasks without success criteria
- ALWAYS use EARS notation for requirements (WHEN/WHILE/WHERE/IF-THEN/SHALL keywords)
- ALWAYS assign unique IDs: FR-N, NFR-N, DEC-N, T-N.N, TS-N.N
- ALWAYS include traceability matrix in design.md mapping Req→Component→Task→Test
- ALWAYS include `<!-- source: FR-N -->` annotations in test-specs.md Gherkin cases
- ALWAYS spawn review agents without model override (uses Claude Code's own model)
- ALWAYS update session.md after each file is completed (dashboard UX)
- ALWAYS record alternatives considered with rationale
- ALWAYS direct user to `alfred dashboard` for approval (not text-based approval)
- Mark `<!-- optional -->` sections as skipped for S-sized tasks (don't force unnecessary detail)
