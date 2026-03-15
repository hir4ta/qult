---
name: polish
description: >
  Convergent decision-making: narrow options to 3, score with criteria, decide
  and move forward. Use when stuck, choosing between options, or turning
  brainstorm output into actionable decisions. Decisions are saved to spec
  automatically. NOT for divergent thinking (use /alfred:salon). NOT for
  full implementation planning (use /alfred:brief).
user-invocable: true
disable-model-invocation: true
argument-hint: "theme or notes"
allowed-tools: Read, Glob, Grep, AskUserQuestion, Agent, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__dossier
context: current
---

# /alfred:polish

Purpose: Produce an "agreed decision" and "next output" to move forward.
Approach: Aligned with Claude Code's Explore -> Plan -> Implement flow, this strengthens the Plan phase.

## Key Principles
- This skill's role is **convergence (decision-making)**. It does not implement.
- This skill's output becomes "input for the next plan/implementation." Leave no ambiguity.
- Where facts are insufficient, ask questions to confirm — do not fill in with speculation.
- If discussion diverges, always return to the "one-line issue."

## alfred-Specific Features
- Use the `knowledge` tool to search for related best practices as decision material
- After Phase 4 (decision), automatically record via `dossier` with action=update, file=decisions.md
- If an active spec exists, check current state via `dossier` with action=status before starting
- **Brainstorm handoff**: If decisions.md contains `<!-- brainstorm output`, pre-populate
  Phase 2 options from the "Top Ideas (ranked)" section and skip Phase 0-1 intake
  (the one-line issue = brainstorm theme, blocker type = "Too many options")

## Phase 0: Blocker Type Diagnosis (1 question)
*Skip this phase if brainstorm output was auto-loaded from spec (see above).*
Ask the user to choose:
1) Unclear question
2) Too many options
3) Can't minimize scope
4) Next step is vague
5) Stopped by anxiety

## Phase 1: Fix the Issue (iterate until agreed)
Create and agree on this one-liner:
- "I want to decide <what to decide> in <situation> within <constraints>"

## Phase 2: Option Inventory (max 5 -> 3)
List existing options if any. Otherwise propose 3 tentative options and refine with Yes/No.

## Phase 3: Evaluation Criteria (3-5) + Rough Scoring
Common axes: Impact / Feasibility / Failure cost / Learning / Sustainability / Low dependency

## Phase 4: Decision (the agreement point)
- Selected option (1) or try 2 options in sequence
- OUT (what NOT to do) — always list 3
- **If an active spec exists, record to decisions.md via `dossier` with action=update**

## Phase 5: Validation Method (fix self-verification conditions)
Test / expected output / screenshot comparison / command

## Phase 6: Finalize One Next Output
Example: 1 diagram / 1-page spec / minimal demo. Completion criteria in 1 line.

## Phase 7: Output (Markdown)
Always use this structure:

```md
# Refine Output: <Theme>

## One-Line Issue (agreed version)
- ...

## Assumptions & Constraints
- ...

## Options (max 3)
1.
2.
3.

## Evaluation Criteria & Rough Scores (1-5)
| Criterion | 1 | 2 | 3 | Notes |
|---|---:|---:|---:|---|
| Impact | | | | |
| Feasibility | | | | |
| Failure cost | | | | |

## Decision
- Selected:
- Reason (brief):
- OUT (not doing):
  - ...
  - ...
  - ...

## Validation
- Command/check:
- Expected result:

## Next Output (do only this)
- Deliverable:
- Completion criteria:
- Reference @file / commands:
```

## Example

User: `/alfred:polish auth strategy`

```
# Refine Output: Auth Strategy

## One-Line Issue
I want to decide which auth method to use for the API gateway within 2 weeks.

## Options (max 3)
1. OAuth2 + PKCE
2. API keys + HMAC
3. Passkeys (WebAuthn)

## Evaluation Criteria & Rough Scores (1-5)
| Criterion    |  1  |  2  |  3  | Notes |
|--------------|----:|----:|----:|-------|
| Feasibility  |  5  |  4  |  2  | Passkeys need browser support |
| Security     |  5  |  3  |  5  | API keys weakest |
| Effort       |  3  |  5  |  2  | OAuth2 has library support |

## Decision
- Selected: OAuth2 + PKCE
- Reason: Best security/feasibility balance, industry standard
- OUT: API keys (weak security), Passkeys (too early for M2M)

Saved to: .alfred/specs/auth-strategy/decisions.md
```

## Troubleshooting

- **User can't choose between options**: Add more evaluation criteria or run a quick web search for evidence.
- **All options score equally**: Ask the user for a tiebreaker criterion ("If you could only optimize for one thing, what would it be?").
- **Brainstorm handoff fails**: If decisions.md doesn't contain brainstorm output, fall back to Phase 0 intake.
- **Spec save fails**: Proceed with the decision in conversation; the user can save manually later.

## Exit Criteria
- One-line issue is agreed
- Narrowed to max 3 options
- One next output is decided
