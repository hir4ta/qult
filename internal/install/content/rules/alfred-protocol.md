---
description: Autonomous spec management for .alfred/specs/ lifecycle
paths:
  - ".alfred/**"
---

# Alfred Protocol — Autonomous Spec Management

When a `.alfred/specs/` directory exists in the project, follow this protocol:

## Session Start
- Call `dossier` with action=status and project_path to check for an active task
- If active, read the session state to understand current position and next steps
- If session.md mentions "Compact Marker", you are resuming after context compaction — read all spec files to restore full context

## Starting New Work
- Before implementation, call `dossier` with action=init to create a spec
- Fill in requirements.md and design.md through conversation with the user

## During Implementation
Record these autonomously — do not wait for user instruction:

**decisions.md** — When you make or recommend a design choice:
```
## [date] Decision Title
- **Chosen:** what was selected
- **Alternatives:** what was considered
- **Reason:** why this option
```

**session.md** — Update when:
- Starting a new sub-task (Currently Working On)
- Completing a milestone (Recent Decisions)
- Encountering a blocker (Blockers)
- Changing files (Modified Files)

## Compact/Session Recovery
After compact or new session, `dossier` with action=status provides session.md.
Read spec files in this order to rebuild context:
1. session.md (where am I?)
2. requirements.md (what am I building?)
3. design.md (how?)
4. decisions.md (why these choices?)

## Completing a Task
- When a task is finished, call `dossier` with action=complete to mark it done
- This preserves spec files for future reference and sets completed_at timestamp
- Primary automatically switches to the next active task
- Prefer complete over delete — completed specs serve as searchable past experience

## Task Lifecycle
- **active** (default): Currently being worked on
- **completed**: Finished — spec files preserved, excluded from active context injection
- **deleted**: Removed entirely (use sparingly — prefer complete)

## Review
- Before committing, review changes against specs (requirements scope, recorded decisions) and best practices
