# Butler Protocol — Autonomous Spec Management

When a `.alfred/specs/` directory exists in the project, follow this protocol:

## Session Start
- Call `spec-status` with project_path to check for an active task
- If active, read the session state to understand current position and next steps
- If session.md mentions "Compact Marker", you are resuming after context compaction — read all spec files to restore full context

## Starting New Work
- Before implementation, call `spec-init` to create a spec
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
After compact or new session, spec-status provides session.md.
Read spec files in this order to rebuild context:
1. session.md (where am I?)
2. requirements.md (what am I building?)
3. design.md (how?)
4. decisions.md (why these choices?)

## Review
- Before committing, call `code-review` to check changes against specs and best practices
