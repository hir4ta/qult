---
name: salon
description: >
  Divergent thinking with 3 agents (Visionary, Pragmatist, Critic) in parallel.
  Use when you need more ideas, want to explore options, or surface risks
  before deciding. NOT for convergent decision-making (use /alfred:polish).
  NOT for structured implementation planning (use /alfred:brief).
user-invocable: true
disable-model-invocation: true
argument-hint: "theme or rough prompt"
allowed-tools: Read, Glob, Grep, AskUserQuestion, Agent, WebSearch, WebFetch, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier
context: fork
model: sonnet
---

# /alfred:salon — Multi-Agent Divergent Thinking

3 specialist agents generate perspectives in parallel, then debate to produce
richer, more grounded divergent output. The goal is not "deciding" but "expanding."

## Key Principles
- This skill's role is **divergence**. It does not judge or decide (decisions are made by /alfred:polish).
- Where facts are insufficient, explicitly label as "hypothesis" — **never assert speculation as fact**.
- Prefer breadth over depth — surface many angles, don't deep-dive on one.

## Supporting Files

- **[agent-prompts.md](agent-prompts.md)** — Prompt templates for Visionary, Pragmatist, Critic, and Synthesis moderator agents

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

## Phase 1: Perspective Generation (staggered, 3 agents)

Search knowledge for relevant context first, then spawn agents in **2 batches**
to avoid rate limits:

1. **Batch 1**: Spawn **Visionary** + **Pragmatist** in a single message (model: haiku).
   Pass each the theme, constraints, and knowledge base results.
2. Wait for both to complete
3. **Batch 2**: Spawn **Critic** (model: haiku) with Batch 1 outputs as additional context

## Phase 2: Cross-Critique (1 round, parent-mediated)

After collecting all 3 agents' output, spawn the **Synthesis moderator** (model: sonnet)
using the prompt from [agent-prompts.md](agent-prompts.md) with all 3 outputs.

## Phase 3: Final Output (Markdown)

Compile everything into this structure:

```md
# Brainstorm Output: <Theme>

## Assumptions
- Goal:
- Constraints:
- Scope:

## Perspectives (3-agent synthesis)

### Visionary — Bold possibilities
- ... (top ideas from Visionary agent)

### Pragmatist — Proven approaches
- ... (top ideas from Pragmatist agent)

### Critic — Risks & blind spots
- ... (top risks from Critic agent)

## Key Tensions (where agents disagreed)
1. <Tension>: Visionary says X, Critic says Y. This matters because...
2. ...

## Hybrid Ideas (synthesis)
- ... (combined ideas from synthesis round)

## Blind Spots (what all 3 missed)
- ...

## Top Ideas (ranked by synthesis)
1.
2.
3.
4.
5.

## Questions to Answer for Convergence (priority order)
1.
2.
3.

## Recommended Next Step
- To converge: /alfred:polish
- To create a spec: /alfred:brief
- To explore: files to read in Plan Mode / commands to investigate
```

## Phase 4: Save for Convergence (spec handoff)

If the user has an active spec (check via `dossier` with action=status), or if the brainstorm
theme maps to a clear task slug, save the brainstorm output for seamless `/alfred:polish` pickup:

1. Call `dossier` with action=init if no spec exists (use theme as slug, e.g. `auth-strategy`)
2. Call `dossier` with action=update, file=decisions.md, content=the full Phase 3 output
   (prefix with `<!-- brainstorm output, pending convergence -->\n`)
3. Tell the user: "Brainstorm saved to spec. Run `/alfred:polish` to converge — it will
   auto-load these results."

If the user declines to save or the theme is too vague for a slug, skip this step.
The brainstorm output in the conversation is always usable directly.

## Example

User: `/alfred:salon auth strategy for our API`

```
# Brainstorm Output: Auth Strategy for API

## Perspectives (3-agent synthesis)

### Visionary — Bold possibilities
- Passkey-first auth (WebAuthn) — eliminate passwords entirely
- Decentralized identity (DID) — user-owned credentials
- ...

### Pragmatist — Proven approaches
- OAuth2 + PKCE — industry standard, battle-tested
- API keys + rate limiting — simplest for M2M
- ...

### Critic — Risks & blind spots
- OAuth complexity: 6-month implementation, not 2-week
- Token storage: JWTs in localStorage = XSS vector
- ...

## Top Ideas (ranked by synthesis)
1. OAuth2 + PKCE (pragmatist + architect consensus)
2. Passkey as progressive enhancement (visionary + pragmatist hybrid)
3. ...

Next: /alfred:polish to converge on a decision
```

## Troubleshooting

- **Agent fails or returns empty**: Re-read the prompt and retry once. If still fails, proceed with 2 agents and note the missing perspective.
- **Synthesis agent repeats agents' output**: Prompt explicitly: "Do NOT restate. Focus only on tensions, blind spots, and hybrid ideas."
- **User wants to go deeper on one idea**: This is convergence territory — redirect to `/alfred:polish`.
- **Too few ideas generated**: Lower the threshold, ask each agent for 3 more ideas with relaxed constraints.

## Exit Criteria
- All 3 specialist agents completed
- Synthesis round completed
- At least 15 ideas generated across all agents
- Key tensions and blind spots identified
- Questions for convergence are ready
