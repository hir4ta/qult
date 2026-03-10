---
name: plan
description: >
  Alfred Protocol: Multi-agent spec generation. Requirements gathering (interactive),
  then 3 specialist agents (Architect, Devil's Advocate, Researcher) deliberate on
  design in parallel, debate, and converge into a robust spec saved to .alfred/specs/.
  Use when: (1) starting a new task, (2) organizing a design, (3) planning before resuming work.
user-invocable: true
disable-model-invocation: true
argument-hint: "<task-slug> [description]"
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Agent, WebSearch, WebFetch, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__spec
model: sonnet
context: current
---

# /alfred:plan — Multi-Agent Spec Generator

Interactively generate a spec with multi-agent design deliberation, creating a
development plan resilient to Compact/session loss.

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

Launch **all 3 agents in a single message** with requirements, constraints,
and research findings.

**Agent 1: Architect** — System design, structure, technical approach
```
You are the Architect. Propose a concrete technical design.

Task: <task-slug>
Requirements: <requirements from Step 3>
Research context: <knowledge + web results from Step 4>

Your job:
1. Search the web for architectural patterns and prior art relevant to this task
2. Propose a concrete architecture (components, data flow, interfaces)
3. List 2-3 alternative approaches you considered and why you rejected them
4. Define the key technical decisions and their rationale
5. Identify dependencies and integration points
6. Propose a task breakdown ordered by dependency

Format: structured markdown with clear sections.
Be specific — name files, functions, data structures. No hand-waving.
```

**Agent 2: Devil's Advocate** — Challenges, weaknesses, failure modes
```
You are the Devil's Advocate. Find weaknesses in any proposed approach.

Task: <task-slug>
Requirements: <requirements from Step 3>
Research context: <knowledge + web results from Step 4>

Your job:
1. Search the web for failure cases and anti-patterns in similar designs
2. Propose YOUR OWN design approach (different from what seems obvious)
3. List 5-7 things that could go wrong with a naive implementation
4. Identify hidden complexity and underestimated effort
5. Surface edge cases the requirements don't mention
6. Challenge assumptions: is the scope right? Are success criteria measurable?

Format: structured markdown with clear sections.
Be constructive — don't just criticize, explain WHY it's a problem and how to mitigate.
```

**Agent 3: Researcher** — Prior art, best practices, existing solutions
```
You are the Researcher. Find evidence and precedent.

Task: <task-slug>
Requirements: <requirements from Step 3>
Research context: <knowledge + web results from Step 4>

Your job:
1. Search the web extensively for how others have solved similar problems
2. Find relevant libraries, tools, or frameworks that could accelerate this
3. Identify applicable design patterns and their trade-offs in this context
4. Surface relevant documentation, blog posts, or case studies
5. Compare 2-3 existing solutions and their strengths/weaknesses
6. Recommend which proven approaches to adopt vs build custom

Format: structured markdown with evidence links and citations.
Be thorough — the goal is to avoid reinventing the wheel.
```

### 6. [DEBATE] Cross-critique round (parent-mediated)

After collecting all 3 agents' output:

1. Identify **agreements** — where all 3 align (these become high-confidence decisions)
2. Identify **conflicts** — where agents disagree (these need resolution)
3. Spawn a **single deliberation agent** with all 3 outputs:

```
You are a technical design mediator. Three specialists have proposed designs for a task.

Architect's proposal: <...>
Devil's Advocate's challenges: <...>
Researcher's findings: <...>

Your job:
1. List points of AGREEMENT across all 3 (these are the "settled" decisions)
2. List points of CONFLICT and for each:
   - State both sides clearly
   - Recommend a resolution with rationale
   - If unresolvable, flag for user decision
3. Synthesize into a UNIFIED design proposal that incorporates:
   - The Architect's structure
   - Mitigations for the Devil's Advocate's concerns
   - The Researcher's proven patterns
4. Produce a final task breakdown with effort estimates (S/M/L)

Be decisive. If the evidence supports one side, choose it. Only escalate to the user
when the trade-off is genuinely subjective.
```

### 7. [CREATE SPEC] Save to .alfred/specs/

1. Call `spec` with action=init to create the spec directory
2. Call `spec` with action=update for each file:
   - **requirements.md**: Goals, success criteria, out of scope (from Step 3)
   - **design.md**: Unified design (from Step 6 synthesis), alternatives considered
   - **decisions.md**: All agreed decisions with rationale + alternatives + source
     (Architect/Advocate/Researcher). Flag unresolved conflicts.
   - **session.md**: Current position + task breakdown as Next Steps

### 8. [OUTPUT] Confirm to user

```
Alfred Protocol initialized for '{task-slug}'.

Design deliberation: 3 agents consulted (Architect, Devil's Advocate, Researcher)
- Agreements: N decisions settled
- Conflicts resolved: N (by evidence)
- Escalated to you: N (need your input)

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

## Guardrails

- Do NOT skip requirements gathering — even for "obvious" tasks
- Do NOT leave decisions.md empty — record ALL design deliberation outcomes
- Do NOT create tasks without success criteria
- ALWAYS record alternatives considered with rationale (from all 3 agents)
- ALWAYS record the source of each decision (which agent proposed, what evidence)
- ALWAYS update session.md with current position after plan completion
- Maximum 20 turns total — force convergence if debate is not settling
