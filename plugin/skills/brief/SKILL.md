---
name: brief
description: >
  Structured spec generation with parallel multi-agent review per file.
  Creates requirements, design, decisions, and session files in .alfred/specs/.
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
1. Call `dossier` action=init to create the spec directory (skip if exists)
2. Call `knowledge` to search for relevant best practices
3. Ask user (max 3 questions):
   - What is the goal? (one sentence)
   - What does success look like? (measurable criteria)
   - What is explicitly out of scope?

### 4. [REQUIREMENTS] Write and review requirements.md

**Write**: Call `dossier` action=update, file=requirements.md with:
- Goal, success criteria, out of scope
- Confidence scores via `<!-- confidence: N -->` on each section

**Review** (3 parallel agents):
Spawn 3 agents simultaneously via Agent tool. Each reads requirements.md and returns findings.
- **Agent 1 — Architect**: Are success criteria measurable and achievable? Missing constraints?
- **Agent 2 — Devil's Advocate**: Is scope too broad? Missing edge cases? Unrealistic criteria?
- **Agent 3 — Researcher**: Any prior art or existing patterns in the codebase that inform requirements?

**Fix**: Collect findings from all 3 agents. Apply fixes, rewrite requirements.md if needed.

**Update session.md**: Mark requirements step as done in Next Steps.

### 5. [DESIGN] Write and review design.md

**Write**: Call `dossier` action=update, file=design.md with:
- Architecture, components, data flow, interfaces
- Name specific files, functions, data structures
- Alternatives considered and why rejected
- Confidence scores on each section

**Review** (3 parallel agents):
Spawn 3 agents simultaneously via Agent tool. Each reads design.md + requirements.md and returns findings.
- **Agent 1 — Architect**: Is the architecture sound? Missing components? Clear interfaces?
- **Agent 2 — Devil's Advocate**: What could go wrong? Hidden complexity? Underestimated effort?
- **Agent 3 — Researcher**: Existing patterns in codebase to reuse? Libraries available?

**Fix**: Collect findings from all 3 agents. Apply fixes, rewrite design.md if needed.

**Update session.md**: Mark design step as done in Next Steps.

### 6. [DECISIONS] Write and review decisions.md

**Write**: Call `dossier` action=update, file=decisions.md with:
- All decisions with rationale + alternatives + which perspective informed each
- Unresolved conflicts flagged for user decision
- Confidence scores

**Review** (3 parallel agents):
Spawn 3 agents simultaneously via Agent tool. Each reads decisions.md + design.md and returns findings.
- **Agent 1 — Architect**: Are decisions consistent with design? Missing decisions?
- **Agent 2 — Devil's Advocate**: Any decision based on faulty assumptions? Reversibility?
- **Agent 3 — Researcher**: Do decisions align with established patterns in this codebase?

**Fix**: Collect findings from all 3 agents. Apply fixes, rewrite decisions.md if needed.

**Update session.md**: Mark decisions step as done in Next Steps.

### 7. [SESSION] Write session.md

**Write**: Call `dossier` action=update, file=session.md with:
- Status: active
- Currently Working On
- Next Steps: task breakdown from design.md (as unchecked items)
- Recent Decisions (last 3)
- Blockers

No review needed for session.md — it's a status file.

### 8. [OUTPUT] Summary to user

```
Spec created for '{task-slug}'.

Deliberation: 3 perspectives applied per file (Architect, Devil's Advocate, Researcher)
- requirements.md ✓ (reviewed)
- design.md ✓ (reviewed)
- decisions.md ✓ (reviewed)
- session.md ✓

Confidence: requirements avg X.X, design avg X.X
[Items with confidence ≤ 5 listed here]

[If unresolved conflicts exist:]
Please decide on these open questions:
1. <conflict description> — Option A vs Option B
```

### 9. [APPROVAL GATE] User reviews in dashboard

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
   - `changes_requested` → read comments, apply fixes, go back to step 9
   - `pending` → remind user to review in dashboard

## Resume Mode (from Step 2)

If an active spec already exists:
1. Call `dossier` action=status to get current session state
2. Read spec files in recovery order: session.md → requirements.md → design.md → decisions.md
3. Present summary: "Resuming task '{slug}'. Last position: {current_position}."
4. Ask: "Continue from here, or update the plan?"

## Guardrails

- Do NOT skip per-file review — each file MUST be reviewed by parallel agents before moving to the next
- Do NOT leave decisions.md empty — record ALL deliberation outcomes
- Do NOT create tasks without success criteria
- ALWAYS spawn review agents without model override (uses Claude Code's own model)
- ALWAYS update session.md after each file is completed (dashboard UX)
- ALWAYS record alternatives considered with rationale
- ALWAYS direct user to `alfred dashboard` for approval (not text-based approval)
