# /qult:spec

Start a new SDD spec. Argument: `<spec-name> <free-form description>`.

## Process

1. Validate `<spec-name>` against `^[a-z0-9][a-z0-9-]{0,63}$`. Reject the reserved name `archive`.
2. Call MCP `get_active_spec`. If a non-archived spec exists, refuse with:
   `active spec already exists: <name>. Run /qult:finish first.`
3. **Stage 1 — requirements**: Draft `requirements.md` (EARS notation: WHEN / IF / WHILE / WHERE).
   Persist to `.qult/specs/<spec-name>/requirements.md`.
4. **Stage 2 — clarify (mandatory, max 3 rounds)**: Generate 5–10 clarification questions on
   ambiguous requirements. Wait for the user's answers, apply them, persist updated requirements.
   Skipping clarify is not allowed.
5. **Stage 3 — requirements gate**: Score the spec on completeness / unambiguity / testability /
   feasibility (0–5 each, total 0–20, threshold 18). Call MCP
   `record_spec_evaluator_score(phase="requirements", total, dim_scores)`. On fail (max 3
   iterations) ask the user `force-progress / abort`.
6. **Stage 4 — design**: Draft `design.md` (architecture, data model, interfaces, dependencies,
   alternatives considered, risks, Wave plan). Score with threshold 17.
7. **Stage 5 — tasks**: Draft `tasks.md` (Wave-by-Wave breakdown with Goal / Verify / per-task
   checkboxes / Consumers). Score with threshold 16.

## Output

```
Spec drafted: .qult/specs/<name>/{requirements,design,tasks}.md
Gates: requirements N/20 · design N/20 · tasks N/20
Next: /qult:wave-start to begin Wave 1
```

## Don'ts

- Do not skip clarify under any condition.
- Do not write spec files outside `.qult/specs/<name>/`.
- Do not call `record_spec_evaluator_score` with `forced_progress: true` unless the user
  explicitly chose it.
