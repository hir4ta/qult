---
name: plan
description: >
  Butler Protocol: Interactively generate a spec. Requirements -> design -> task breakdown,
  saved to .alfred/specs/. Creates a development plan resilient to Compact/session loss.
  Use when: (1) starting a new task, (2) organizing a design, (3) planning before resuming work.
user-invocable: true
argument-hint: "<task-slug> [description]"
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__spec-init, mcp__alfred__spec-update, mcp__alfred__spec-status
context: current
---

# /alfred:plan — Butler Protocol Spec Generator

Interactively generate a spec, creating a development plan resilient to Compact/session loss.

## Core Principle
**What Compact loses most: reasoning process, rationale for design decisions, dead-end explorations, implicit agreements.**
By explicitly writing these to files, we create a spec that enables perfect recovery regardless of when the session is interrupted.

## Steps

1. **[WHAT]** Parse $ARGUMENTS:
   - task-slug (required): URL-safe identifier
   - description (optional): brief summary
   - If no arguments, confirm via AskUserQuestion

2. **[HOW]** Call `spec-status` to check existing state:
   - If active spec exists for this slug -> resume mode (skip to Step 7)
   - If no spec -> creation mode (continue)

3. **[HOW]** Requirements gathering (interactive, max 3 questions):
   - What is the goal? (one sentence)
   - What does success look like? (measurable criteria)
   - What is explicitly out of scope?

4. **[HOW]** Design decisions (interactive + knowledge search):
   - Call `knowledge` to search for relevant best practices
   - Discuss architecture approach
   - Record alternatives considered (CRITICAL for compact resilience)

5. **[HOW]** Task breakdown:
   - Break into concrete, checkable tasks
   - Order by dependency

6. **[HOW]** Call `spec-init` with gathered information:
   - Creates all 4 files with templates
   - Then call `spec-update` for each file to fill in gathered content:
     - requirements.md: replace with full requirements
     - design.md: replace with design decisions
     - decisions.md: append initial design decisions
     - session.md: replace with current position + next steps

7. **[OUTPUT]** Confirm to user:
   ```
   Butler Protocol initialized for '{task-slug}'.

   Spec files: .alfred/specs/{task-slug}/
   - requirements.md ✓
   - design.md ✓
   - decisions.md ✓
   - session.md ✓

   DB synced: {N} documents indexed.

   Compact resilience: Active. Session state will auto-save before compaction.
   Session recovery: Active. Context will auto-restore on session start.

   Ready to implement. Start with the first item in Next Steps.
   ```

## Resume Mode (from Step 2)

If an active spec already exists:
1. Call `spec-status` to get current session state
2. Read spec files in recovery order:
   - session.md (where am I?)
   - requirements.md (what am I building?)
   - design.md (how?)
   - decisions.md (why these choices?)
3. Present summary: "Resuming task '{slug}'. Last position: {current_position}. Next steps: {next_steps}"
4. Ask: "Continue from here, or update the plan?"

## Guardrails

- Do NOT skip requirements gathering — even for "obvious" tasks
- Do NOT leave decisions.md empty — record at least the initial approach decision
- Do NOT create tasks without success criteria
- ALWAYS record alternatives considered, even if only briefly
- ALWAYS update session.md with current position after plan completion
