---
name: salon
description: >
  Divergent thinking with 3 inline perspectives (Visionary, Pragmatist, Critic).
  Use when you need more ideas, want to explore options, or surface risks
  before deciding. NOT for convergent decision-making (use /alfred:polish).
  NOT for structured implementation planning (use /alfred:brief).
user-invocable: true
disable-model-invocation: true
argument-hint: "theme or rough prompt"
allowed-tools: Read, Glob, Grep, AskUserQuestion, WebSearch, WebFetch, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier
context: fork
---

# /alfred:salon — Multi-Perspective Divergent Thinking

3 perspectives generate ideas inline, then synthesize to produce richer,
more grounded divergent output. No sub-agents are spawned.

## Key Principles
- This skill's role is **divergence**. It does not judge or decide.
- Where facts are insufficient, explicitly label as "hypothesis".
- Prefer breadth over depth — surface many angles, don't deep-dive on one.

## Phase 0: Intake (AskUserQuestion recommended)

Confirm with up to 3 questions (with choices):
1) What is the goal? (determine direction / expand options / surface risks / reframe)
2) Any constraints? (deadline / tech / budget / hard no's)
3) What is the scope? (personal / team / product / learning)

*If the user says "you decide", proceed with reasonable defaults.*

## Phase 1: Perspective Generation (inline, single pass)

Search `knowledge` for relevant context first, then analyze the theme from
3 perspectives in a single structured response:

### Perspective 1: Visionary — Bold possibilities
- 5+ unconventional ideas that push boundaries
- "What if we could...?" framing
- Connect to adjacent domains for inspiration

### Perspective 2: Pragmatist — Proven approaches
- 5+ practical, tested approaches
- Cost/benefit for each
- Implementation complexity estimate (S/M/L)

### Perspective 3: Critic — Risks & blind spots
- 5+ potential failure modes and risks
- Assumptions being made by Visionary and Pragmatist
- What everyone is likely overlooking

## Phase 2: Synthesis (inline)

After generating all 3 perspectives:

1. **Key Tensions**: Where do perspectives disagree? Why does it matter?
2. **Hybrid Ideas**: Combine elements from different perspectives
3. **Blind Spots**: What did all 3 perspectives miss?
4. **Top Ideas**: Rank by potential impact × feasibility

## Phase 3: Final Output (Markdown)

```md
# Brainstorm Output: <Theme>

## Assumptions
- Goal:
- Constraints:
- Scope:

## Perspectives

### Visionary — Bold possibilities
- ...

### Pragmatist — Proven approaches
- ...

### Critic — Risks & blind spots
- ...

## Key Tensions (where perspectives disagreed)
1. <Tension>: Visionary says X, Critic says Y. This matters because...

## Hybrid Ideas (synthesis)
- ...

## Blind Spots (what all 3 missed)
- ...

## Top Ideas (ranked)
1.
2.
3.
4.
5.

## Questions to Answer for Convergence
1.
2.
3.

## Recommended Next Step
- To converge: /alfred:polish
- To create a spec: /alfred:brief
```

## Phase 4: Save for Convergence

If the user has an active spec or the theme maps to a task slug:
1. Call `dossier` action=init if no spec exists
2. Call `dossier` action=update, file=decisions.md with the brainstorm output
3. Tell user: "Brainstorm saved to spec. Run /alfred:brief to plan."

## Guardrails

- Do NOT spawn sub-agents — all perspectives are inline (rate limit prevention)
- Do NOT converge or decide — this is a divergence skill
- ALWAYS generate at least 15 ideas across all perspectives
- ALWAYS identify tensions and blind spots
- Label speculation as "hypothesis", never assert as fact

## Troubleshooting

- **Theme too vague**: Ask the user to narrow the scope using the Phase 0 intake questions. A clear goal and constraints produce much better divergent output.
- **Knowledge search returns nothing relevant**: Proceed with general brainstorming based on the theme. The skill works without prior knowledge — it just produces richer output with context.
