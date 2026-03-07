---
name: refine
description: |
  Convergent thinking: Fix the issue to one line, narrow options to 3 max, score with criteria, finalize the next output as Markdown.
  Decisions are automatically saved to spec via spec-update.
  Use when: (1) stuck and can't move forward, (2) have candidates but can't choose, (3) need to define minimum scope,
  (4) need to turn brainstorm results or notes into decisions.
user-invocable: true
argument-hint: "<theme or current messy notes>"
allowed-tools: Read, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__spec-update, mcp__alfred__spec-status
context: current
---

# /alfred:refine

Purpose: Produce an "agreed decision" and "next output" to move forward.
Approach: Aligned with Claude Code's Explore -> Plan -> Implement flow, this strengthens the Plan phase.

## Key Principles
- This skill's role is **convergence (decision-making)**. It does not implement.
- This skill's output becomes "input for the next plan/implementation." Leave no ambiguity.
- Where facts are insufficient, ask questions to confirm — do not fill in with speculation.
- If discussion diverges, always return to the "one-line issue."

## alfred-Specific Features
- Use the `knowledge` tool to search for related best practices as decision material
- After Phase 4 (decision), automatically record via `spec-update decisions.md`
- If an active spec exists, check current state via `spec-status` before starting

## Phase 0: Blocker Type Diagnosis (1 question)
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
- **If an active spec exists, record to decisions.md via `spec-update`**

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

## Exit Criteria
- One-line issue is agreed
- Narrowed to max 3 options
- One next output is decided
