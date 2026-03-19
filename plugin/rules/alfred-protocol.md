---
description: Autonomous spec management for .alfred/specs/ lifecycle
paths:
  - ".alfred/**"
---

# Alfred Protocol — Autonomous Spec Management

When a `.alfred/specs/` directory exists in the project, follow this protocol:

## Session Start
- Call `dossier` with action=status and project_path to check for an active task
- If active, read tasks.md to understand current progress and next steps

## Starting New Work
- Before implementation, call `dossier` with action=init to create a spec
- Fill in requirements.md and design.md through conversation with the user

## During Implementation
Record decisions autonomously via `ledger action=save sub_type=decision` — do not wait for user instruction.

Progress is tracked automatically via tasks.md checkboxes (PostToolUse hook).

## Compact/Session Recovery
After compact or new session, `dossier` with action=status provides full spec context.
Read spec files in this order to rebuild context:
1. tasks.md (progress + next steps)
2. requirements.md (what am I building?)
3. design.md (how?)

## Completing a Task
- When a task is finished, call `dossier` with action=complete to mark it done
- This preserves spec files for future reference and sets completed_at timestamp
- Primary automatically switches to the next active task
- Prefer complete over delete — completed specs serve as searchable past experience

## Task Lifecycle
- **pending**: Created but not yet started
- **in-progress**: Actively being worked on (auto-set on first Edit/Write)
- **review**: Wave completed, self-review required
- **done**: Finished — spec files preserved
- **deferred**: Paused (toggle via `dossier action=defer`)
- **cancelled**: Abandoned
- **deleted**: Removed entirely (use sparingly — prefer complete)

## Review
- Before committing, review changes against specs (requirements scope, recorded decisions) and best practices
