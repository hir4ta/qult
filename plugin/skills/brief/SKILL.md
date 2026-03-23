---
name: brief
description: >
  Use when starting a new task, organizing a design, planning before implementation,
  or wanting a structured development plan. NOT for autonomous implementation (use /alfred:attend).
user-invocable: true
argument-hint: "task-slug [description]"
allowed-tools: Read, Edit, Glob, Grep, Agent, AskUserQuestion, WebSearch, WebFetch, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier
context: current
---

# /alfred:brief — Spec Generator with Staged Review

Generate a structured spec through iterative file-by-file creation with
parallel multi-agent review after each file.

## Red Flags

These thought patterns signal you are about to violate this skill's rules:

- "This spec file doesn't need reviewers" → L/XL specs get 3 parallel agents, M gets 1. Only S/D may skip. Check the size before deciding.
- "I'll skip research.md since the answer is obvious" → Obvious answers are often wrong. Research validates assumptions.
- "Low confidence is fine, I'll verify later" → Ungrounded specs propagate errors downstream. Flag and resolve now.
- "I can write all files at once then review" → File-by-file review catches cross-file inconsistencies early.

## Spec v2 File System (7 files)

| File | Purpose | ID Prefix |
|------|---------|-----------|
| requirements.md | EARS requirements + NFR + acceptance criteria | FR-N, NFR-N |
| design.md | Architecture + data models + API + traceability matrix | — |
| tasks.md | Wave-based task decomposition + parallel markers | T-N.N |
| test-specs.md | Gherkin test cases + edge cases + coverage matrix | TS-N.N |
| research.md | Investigation + gap analysis + implementation options | — |
| tasks.md | Wave-based task decomposition + parallel markers | T-N.N |

## Core Principle

### Review targets
Only **requirements.md** and **design.md** get agent review. These two files
define the contract — errors here propagate everywhere. Other files get a quick
inline sanity check for critical issues only (no agents).

### Review depth by size

| Size | requirements.md + design.md | Other files |
|------|---------------------------|-------------|
| S/D | Inline self-review (no agents) | Inline self-review |
| M | 1 agent (Architect) per file | Quick inline check |
| L/XL | 3 parallel agents per file | Quick inline check |

### Review loop (requirements.md + design.md only)
Agent review follows a **fix-and-re-review loop**:
1. Write file → agent review → collect findings
2. Fix Critical/High findings → re-submit to agents
3. Repeat until **0 Critical + 0 High** findings remain
4. Low/Medium findings: note them but proceed

Max 3 iterations to prevent infinite loops. If Critical/High persist after 3
rounds, flag to user and proceed.

This skill implements the spec creation phase of the **invariant Spec-Driven
Development Flow** (see CLAUDE.md): Spec > Wave > Task hierarchy.

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

**Quick check** (inline, no agents): Scan for critical gaps — missing code analysis, overlooked risks, placeholder content. Fix and move on.

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

**Review + fix loop** (see Core Principle — this is a key review target):
- **S/D**: Self-review inline
- **M**: Spawn 1 agent (Architect): EARS patterns correct? Measurable criteria? Missing constraints? → fix Critical/High → re-review until clean
- **L/XL**: Spawn 3 agents → fix Critical/High → re-review until clean:
  - **Architect**: EARS patterns correct? Measurable criteria? Missing constraints?
  - **Devil's Advocate**: Scope too broad? Missing edge cases? Unrealistic criteria?
  - **Researcher**: Prior art? Existing patterns that inform requirements?

**Fix**: Apply fixes, rewrite if needed.

### 6. [DESIGN] Write and review design.md

**Write**: Call `dossier` action=update, file=design.md with:
- Architecture overview, component design with **interfaces** (function signatures)
- **Data models** (SQL schema or struct definitions)
- **API contracts** (endpoints + request/response + error codes)
- **Requirements traceability matrix**: Req ID → Component → Task ID → Test ID
- Migration strategy (if applicable)
- Tech decisions quick reference (save via `ledger action=save sub_type=decision`)

**Review + fix loop** (see Core Principle — this is a key review target):
- **S/D**: Self-review inline
- **M**: Spawn 1 agent (Architect): Sound architecture? Clear interfaces? → fix Critical/High → re-review until clean
- **L/XL**: Spawn 3 agents → fix Critical/High → re-review until clean:
  - **Architect**: Sound architecture? Clear interfaces? Missing components?
  - **Devil's Advocate**: What could go wrong? Hidden complexity? Underestimated effort?
  - **Researcher**: Codebase patterns to reuse? Consistency with existing design?

### 7. [TASKS] Write and review tasks.md

**Write**: Call `dossier` action=update, file=tasks.md with:
- Summary (total count, size breakdown, parallel-safe count)
- Tasks organized into **Waves** (Foundation → Core → Edge Cases → Polish)
- Each task: T-N.N [S/M/L/XL] (P) description
  - `_Requirements: FR-N | Depends: T-N.N | Files: path_`
- Size legend (S/M/L/XL definitions)
- Dependency graph (ASCII)

**Quick check** (inline, no agents): Verify wave ordering, dependency graph validity, all FRs covered. Fix critical issues only.

### 8. [TEST-SPECS] Write and review test-specs.md

**Write**: Call `dossier` action=update, file=test-specs.md with:
- **Coverage matrix**: Req ID → Test IDs → Type → Priority (P0/P1/P2) → Status
- **Test cases in Gherkin**: Each with `<!-- source: FR-N -->` annotation
  - Map EARS: WHILE→Given, WHEN→When, SHALL→Then
- **Edge case matrix**: Scenario → Input → Expected → Req
- **Boundary values** table (if applicable)
- **Test data & fixtures** (if applicable)
- **Security test cases** (if applicable)

**Quick check** (inline, no agents): Verify all FRs have test coverage, Gherkin syntax valid, no orphan tests. Fix critical issues only.

### 9. [DECISIONS] Save decisions to knowledge

Save all decisions directly via `ledger action=save sub_type=decision`:
- title, context, decision, reasoning, alternatives
- No decisions.md file — decisions go straight to knowledge for cross-task search
- Include decisions from research.md option selection
- Unresolved conflicts flagged for user decision

**Quick check** (inline, no agents): Verify decisions are consistent with design, alternatives recorded.

### 10. Clear spec-review gate
After all spec files reviewed and fixed, clear the review gate:
```
dossier action=gate sub_action=clear reason="3-agent review completed for all spec files. Findings: [summarize key findings and fixes]"
```
This is MANDATORY — PreToolUse blocks source Edit/Write until gate is cleared.

### 11. [OUTPUT] Summary to user

```
Spec created for '{task-slug}'.

Review: requirements.md + design.md (agent loop until 0 Critical/High)
- research.md ✓ (reviewed)
- requirements.md ✓ (reviewed)
- design.md ✓ (reviewed)
- tasks.md ✓ (reviewed)
- test-specs.md ✓ (reviewed)
- tasks.md ✓
- decisions → ledger ✓

Confidence: requirements avg X.X, design avg X.X
[Items with confidence ≤ 5 and source=assumption listed here]

[If unresolved conflicts exist:]
Please decide on these open questions:
1. <conflict description> — Option A vs Option B
```

## Resume Mode (from Step 2)

If an active spec already exists:
1. Call `dossier` action=status to get current session state
2. Read spec files in recovery order: tasks.md → requirements.md → design.md → tasks.md
3. Present summary: "Resuming task '{slug}'. Last position: {current_position}."
4. Ask: "Continue from here, or update the plan?"

## Guardrails

- Do NOT skip requirements.md + design.md review — these get agent review + fix loop (Critical/High must be 0 before proceeding)
- Do NOT skip decision recording — save ALL deliberation outcomes via `ledger save sub_type=decision`
- Do NOT create tasks without success criteria
- ALWAYS use EARS notation for requirements (WHEN/WHILE/WHERE/IF-THEN/SHALL keywords)
- ALWAYS assign unique IDs: FR-N, NFR-N, DEC-N, T-N.N, TS-N.N
- ALWAYS include traceability matrix in design.md mapping Req→Component→Task→Test
- ALWAYS include `<!-- source: FR-N -->` annotations in test-specs.md Gherkin cases
- ALWAYS spawn review agents without model override (uses Claude Code's own model)
- ALWAYS update tasks.md after each file is completed (dashboard UX)
- ALWAYS record alternatives considered with rationale
- Mark `<!-- optional -->` sections as skipped for S-sized tasks (don't force unnecessary detail)
- ALWAYS include "Wave: Closing" tasks (self-review, CLAUDE.md update, test verification) — these trigger auto-complete when all checked

## Troubleshooting

- **dossier init fails (spec already exists)**: Use `dossier action=status` to check the existing spec. Either resume it, `dossier action=delete confirm=true` to remove it, or choose a different task-slug.
- **Agent review divergence (conflicting feedback)**: Prioritize Architect findings for structural issues, Devil's Advocate for scope/risk. Save the conflict resolution as a decision via `ledger save sub_type=decision` and pick the safer option.
