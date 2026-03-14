---
name: plan
description: >
  Multi-agent spec generation with 3 specialists (Architect, Devil's Advocate,
  Researcher). Creates requirements, design, decisions, and session files in
  .alfred/specs/. Use when starting a new task, organizing a design, planning
  before implementation, or wanting a structured development plan. NOT for
  divergent brainstorming (use /alfred:brainstorm). NOT for autonomous
  implementation (use /alfred:develop).
user-invocable: true
argument-hint: "task-slug [description]"
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Agent, WebSearch, WebFetch, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__spec
model: sonnet
context: current
---

# /alfred:plan — Multi-Agent Spec Generator

Interactively generate a spec with multi-agent design deliberation, creating a
development plan resilient to Compact/session loss.

## Supporting Files

- **[agent-prompts.md](agent-prompts.md)** — Prompt templates for Architect, Devil's Advocate, Researcher, and Mediator agents

## Core Principle
**What Compact loses most: reasoning process, rationale for design decisions, dead-end
explorations, implicit agreements.** By explicitly writing these to files AND having
multiple agents debate the design, we create specs that are both robust and well-reasoned.

## Steps

### 1. [WHAT] Parse $ARGUMENTS
- task-slug (required): URL-safe identifier
- description (optional): brief summary
- If no arguments, confirm via AskUserQuestion

### 2. [CHECK] Call `spec` with action=status
- If active spec exists for this slug -> resume mode (skip to Step 8)
- If no spec -> creation mode (continue)

### 3. [REQUIREMENTS] Interactive gathering (max 3 questions)
- What is the goal? (one sentence)
- What does success look like? (measurable criteria)
- What is explicitly out of scope?

### 4. [RESEARCH] Knowledge base + web search
- Call `knowledge` to search for relevant best practices and patterns
- Note any relevant prior art or conventions

### 5. [DESIGN DELIBERATION] Spawn 3 specialist agents in parallel

Launch **all 3 agents in a single message** using the prompts from
[agent-prompts.md](agent-prompts.md). Pass requirements, constraints, and research findings.

### 6. [DEBATE] Cross-critique round (parent-mediated)

After collecting all 3 agents' output, spawn the **Mediator agent** using
the mediator prompt from [agent-prompts.md](agent-prompts.md) with all 3 outputs.

### 7. [CREATE SPEC] Save to .alfred/specs/

1. Call `spec` with action=init to create the spec directory
2. Call `spec` with action=update for each file:
   - **requirements.md**: Goals, success criteria, out of scope (from Step 3)
   - **design.md**: Unified design (from Step 6 synthesis), alternatives considered
   - **decisions.md**: All agreed decisions with rationale + alternatives + source
     (Architect/Advocate/Researcher). Flag unresolved conflicts.
   - **session.md**: Current position + task breakdown as Next Steps

3. **Assign confidence scores** (1-10) to each section using HTML comments:
   ```markdown
   ## API設計 <!-- confidence: 8 -->
   RESTful + OpenAPI 3.0 (Architect + Researcher agreed, evidence from prior art)

   ## 認証方式 <!-- confidence: 3 -->
   OAuth2 or API Key — unresolved conflict (needs user decision)
   ```
   Scale: 1-3 low (speculation), 4-6 medium (inference), 7-9 high (evidence), 10 certain.
   Items scoring ≤ 5 are flagged in Step 8 output for user attention.

### 8. [OUTPUT] Confirm to user

```
Alfred Protocol initialized for '{task-slug}'.

Design deliberation: 3 agents consulted (Architect, Devil's Advocate, Researcher)
- Agreements: N decisions settled
- Conflicts resolved: N (by evidence)
- Escalated to you: N (need your input)

Confidence: requirements avg X.X (N items ≤ 5), design avg X.X
[Items with confidence ≤ 5 need your attention — listed below]

Spec files: .alfred/specs/{task-slug}/
- requirements.md ✓
- design.md ✓
- decisions.md ✓
- session.md ✓

Compact resilience: Active.

[If escalated conflicts exist:]
Before starting, please decide on these open questions:
1. <conflict description> — Option A vs Option B
2. ...
```

## Resume Mode (from Step 2)

If an active spec already exists:
1. Call `spec` with action=status to get current session state
2. Read spec files in recovery order:
   - session.md (where am I?)
   - requirements.md (what am I building?)
   - design.md (how?)
   - decisions.md (why these choices?)
3. Present summary: "Resuming task '{slug}'. Last position: {current_position}."
4. Ask: "Continue from here, or update the plan?"

## Troubleshooting

- **Agent fails or returns empty**: Re-read the prompt from agent-prompts.md and retry once. If still fails, proceed with 2 agents' output and note the gap.
- **Agents all agree (no conflict)**: Still run the Mediator to confirm consensus and check for blind spots.
- **Spec init fails**: Check if `.alfred/specs/{slug}` already exists. Use `spec` action=status first.
- **User doesn't answer requirements questions**: Proceed with reasonable defaults, flag assumptions with low confidence scores (1-3).

## Example

User: `/alfred:plan auth-refactor Add OAuth2 to the API gateway`

```
Alfred Protocol initialized for 'auth-refactor'.

Design deliberation: 3 agents consulted (Architect, Devil's Advocate, Researcher)
- Agreements: 4 decisions settled
- Conflicts resolved: 2 (by evidence)
- Escalated to you: 1 (need your input)

Confidence: requirements avg 8.2 (0 items ≤ 5), design avg 6.8 (2 items ≤ 5)

Spec files: .alfred/specs/auth-refactor/
- requirements.md ✓
- design.md ✓
- decisions.md ✓
- session.md ✓

Before starting, please decide:
1. Token storage — PostgreSQL (Architect) vs Redis (Researcher). Trade-off: durability vs latency.
```

## Guardrails

- Do NOT skip requirements gathering — even for "obvious" tasks
- Do NOT leave decisions.md empty — record ALL design deliberation outcomes
- Do NOT create tasks without success criteria
- ALWAYS record alternatives considered with rationale (from all 3 agents)
- ALWAYS record the source of each decision (which agent proposed, what evidence)
- ALWAYS update session.md with current position after plan completion
- Maximum 20 turns total — force convergence if debate is not settling
