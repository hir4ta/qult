---
name: clarify
description: "Re-run clarification on the active spec — generates 5-10 questions, applies answers to requirements.md, re-scores Unambiguity. Use when scope changes mid-spec or the spec-evaluator's Unambiguity dim is below floor."
---

# /qult:clarify

Targeted re-clarify on the **active** spec without restarting the whole `/qult:spec` flow.

## Pre-flight

1. `mcp__plugin_qult_qult__get_active_spec`. If null, refuse: "no active spec; nothing to clarify".
2. If `task_summary.done > 0` for any Wave (implementation already started), warn and confirm before proceeding — clarify mid-implementation usually means a scope problem.

## Loop (max 3 rounds, hard cap)

1. Spawn `spec-clarifier` in **generate mode** on the current `requirements.md`.
2. Present the questions verbatim, wait for the architect's reply.
3. Spawn `spec-clarifier` in **apply mode**; persist the resulting `requirements.md`.
4. If a `## Scope-rename suggestion` appears, surface it and stop the loop — the architect must decide whether to start a fresh spec.
5. Re-run `spec-evaluator` with `phase=requirements`. Record via `record_spec_evaluator_score`.
6. Exit on pass OR after 3 rounds.

## Output

```
Clarify completed: <N> rounds, <M> Open Questions resolved.
Requirements score: <total>/20  (Unambiguity=<n>/5)
```

When the loop exits below threshold, present `force-progress / abort` to the architect (same pattern as `/qult:spec`).
