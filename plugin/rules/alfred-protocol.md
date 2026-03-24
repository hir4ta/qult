# Alfred Protocol — Spec-Driven Development

When a `.alfred/specs/` directory exists in the project, follow this protocol strictly.

## Spec Proposal

Before writing implementation code (new features, bug fixes, refactors):

1. Check if an active spec exists via `dossier action=status`
2. If no active spec, use AskUserQuestion to ask: "Spec を作成しますか？ (S/M/L/Skip)"
3. Always propose — never silently skip. User can say "skip" to proceed without spec
4. If active spec exists for a different task, confirm with user before proceeding

## Skill Selection

Match the user's intent to the appropriate skill:

- New feature / implementation → `/alfred:attend`
- Bug fix / error resolution → `/alfred:mend`
- Code review / audit → `/alfred:inspect`
- Planning / design → `/alfred:brief`
- Test-driven development → `/alfred:tdd`

If there is even a small chance a skill applies, suggest it.

## Spec Creation & Review

1. Create spec documents (requirements.md, design.md, tasks.json, etc.)
2. Run self-review via `alfred:code-reviewer` agent or `/alfred:inspect`
   - OK (0 Critical/High) → proceed to implementation
   - NG → fix → re-review (loop until 0 Critical/High)

## Implementation — Per Wave

### Task Completion

- After completing a task, call `dossier action=check task_id="T-X.Y"` explicitly
- After Edit/Write, compare changes against tasks.json unchecked tasks
- If a task appears complete based on the files changed, call dossier check

### Wave Completion

When all tasks in a Wave are done:

1. **Commit** with Wave number in message
2. **Self-review** via `alfred:code-reviewer` agent or `/alfred:inspect`
3. **Fix** Critical/High findings before proceeding
4. **Gate clear** — `dossier action=gate sub_action=clear reason="<review summary>"` (30+ chars, include: review method, findings count, fix summary)
5. **Knowledge** — `ledger action=save` (pattern/decision/rule). If nothing to save, state why
6. **Next Wave** — Proceed immediately. Do NOT stop and wait for user input

### Source File Tracking

- After committing, check if any changed source files are missing from design.md
- If untracked files exist, consider adding them to the relevant component section

## Completing a Spec

- When all tasks (including Closing Wave) are checked, call `dossier action=complete`
- Prefer complete over delete — completed specs serve as searchable knowledge

## Before Stopping

- Check tasks.json for unchecked tasks and self-review items
- If all done, call `dossier action=complete` to close the spec
- Do not stop mid-wave without committing progress

## Compact / Session Recovery

After compact or new session:
1. Call `dossier action=status`
2. Read tasks.json (progress), requirements.md (goal), design.md (architecture)
