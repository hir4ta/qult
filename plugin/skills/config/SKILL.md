---
name: config
description: View or change qult config values stored in .qult/config.json. Includes review thresholds, spec_eval phase thresholds, and reviewer model overrides. NOT for gate enable/disable (use /qult:skip).
user_invocable: true
---

# /qult:config

View or change qult configuration values. State lives in `.qult/config.json` (project-local, committed); `~/.qult/` global config is **not used**.

## Show

1. Call `mcp__plugin_qult_qult__get_project_status()` — response includes `review_config` (all review settings + reviewer model overrides).
2. If `.qult/config.json` exists, also present its raw contents so the architect sees what is project-specific vs default.

## Change

Allowed keys (depth 2 or 3 — `setConfigKey` rejects anything else):

### review (4-stage independent review on changed code)

| key | type | default | meaning |
|---|---|---|---|
| `review.score_threshold` | number | 30 | aggregate of 8 dimensions (max 40) |
| `review.max_iterations` | number | 3 | retry cap when reviewers FAIL |
| `review.required_changed_files` | number | 5 | file-count trigger for /qult:review prompt |
| `review.dimension_floor` | number | 4 | minimum per-dimension score (1-5) |
| `review.require_human_approval` | boolean | false | if true, architect must call `record_human_approval` |
| `review.low_only_passes` | boolean | false | if true, accept reviews where all findings are `[low]` |
| `review.models.spec` | string | "sonnet" | one of: sonnet / opus / haiku / inherit |
| `review.models.quality` | string | "sonnet" | |
| `review.models.security` | string | "opus" | |
| `review.models.adversarial` | string | "opus" | |

### spec_eval (per-phase gate when /qult:spec runs)

These are read directly from `.qult/config.json` by `/qult:spec` (no MCP setter — the architect edits the file directly or via `set_config` on a flat key path):

| key | type | default | meaning |
|---|---|---|---|
| `spec_eval.thresholds.requirements` | number | 18 | of 20 |
| `spec_eval.thresholds.design` | number | 17 | of 20 |
| `spec_eval.thresholds.tasks` | number | 16 | of 20 |
| `spec_eval.dimension_floor` | number | 4 | of 5 |
| `spec_eval.iteration_limit` | number | 3 | rounds before force-progress prompt |

### plan_eval (deprecated alias kept for back-compat)

`plan_eval.score_threshold` / `plan_eval.max_iterations` still exist in the loaded config but **are no longer consumed** (replaced by `spec_eval`). Setting them is a no-op for the SDD pipeline; it's kept only to avoid breaking older detectors that read the field.

## Procedure

1. Validate the key is one of the allowed set above.
2. Call `mcp__plugin_qult_qult__set_config({ key, value })`.
3. The MCP handler writes to `.qult/config.json` (atomic) and resets the in-process cache.
4. Confirm the new value via `get_project_status`.

## Reset to defaults

`.qult/config.json` is project-local. To reset:
- Delete the entire file: `rm .qult/config.json`. Defaults take effect immediately (no migration needed).
- Or remove a single key by editing the JSON directly.
