---
name: brainstorm
description: |
  Divergent thinking: Generate perspectives, options, hypotheses, and questions from a rough theme, producing decision-ready Markdown.
  Leverages alfred knowledge to supplement with relevant information from the knowledge base.
  Use when: (1) unsure what to think about, (2) ideas are few or thinking is rigid,
  (3) need to surface risks and issues, (4) need raw material for convergence (/alfred:refine).
user-invocable: true
argument-hint: "<theme or rough prompt>"
allowed-tools: Read, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__spec-init
context: fork
---

# /alfred:brainstorm

A skill for divergent thinking with AI — expanding options, perspectives, hypotheses, and questions.
The goal is not "deciding" but "expanding." However, it creates an entry point to convergence at the end.

## Key Principles
- This skill's role is **divergence**. It does not judge or decide (decisions are made by /alfred:refine).
- Where facts are insufficient, explicitly label as "hypothesis" — **never assert speculation as fact**.
- If output gets too long, compress to key points and continue.

## alfred-Specific Features
- In Phase 1, use the `knowledge` tool to search the knowledge base for related documents and best practices as divergence material
- After Phase 4 output, offer the option "Create a spec with spec-init?"
- Output can be persisted to DB (via spec-init)

## Phase 0: Intake & Minimal Assumption Check (AskUserQuestion recommended)
Confirm with up to 3 questions (with choices):

1) What is the goal?
- a) Determine direction
- b) Expand options
- c) Surface risks/issues
- d) Reframe the question

2) Any constraints?
- Deadline / time / budget / team / tech restrictions / hard no's

3) What is the scope?
- Personal decision / team consensus / product / learning / career etc

*If the user says "you decide", proceed with reasonable defaults.*

## Phase 1: Comprehensive Perspectives (Divergence) + Knowledge Search
First, use the `knowledge` tool to search for documents related to the theme as divergence material.

At minimum, produce these "perspective blocks":
- Goals & success state (What good looks like)
- Target users/situations (Who is affected and how)
- Approach types (Categories of solutions)
- Trade-off axes (Speed/quality, short-term/long-term, etc.)
- Risks / failure patterns
- Validation (How to verify)

## Phase 2: Idea Generation (in bundles)
3 bundles — "Conservative / Realistic / Experimental", 3-7 ideas each.
Each idea must follow this brief format:
- One-liner
- 30-second explanation
- When it works
- Fit with constraints
- Minimal validation

## Phase 3: Generate Questions for Convergence
Create 5-12 questions needed for convergence (decision-making).

## Phase 4: Output (Markdown)
Always use this structure:

```md
# Brainstorm Output: <Theme>

## Assumptions
- Goal:
- Constraints:
- Scope:

## Perspectives (coverage check)
- ...

## Idea Bundles
### Conservative
- ...
### Realistic
- ...
### Experimental
- ...

## Risks / Concerns (anticipated failure patterns)
- ...

## Validation Seeds
- Test ideas:
- Observation/logging ideas:

## Questions to Answer for Convergence (priority order)
1.
2.
3.

## Recommended Next Step
- To converge: /alfred:refine
- To create a spec: /alfred:plan
- To explore: files to read in Plan Mode / commands to investigate
```

## Exit Criteria
- User says "enough"
- At least 10 ideas generated across bundles
- Questions for convergence are ready
