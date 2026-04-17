---
name: config
description: View or change qult config values (score thresholds, iteration limits, review file threshold). Use to adjust quality gate sensitivity for the current project. NOT for gate management (use /qult:skip instead).
user_invocable: true
---

# /qult:config

View or change qult configuration values.

## Usage

The user will specify what they want:
- "show config" / "current settings" -> show current config
- "set score threshold to 10" / "lower review threshold" -> change a value
- "reset config" -> use MCP set_config to reset values to defaults

## Steps

### Show current config

1. Call `mcp__plugin_qult_qult__get_session_status()` — response includes `review_config` field with all current review settings (score_threshold, dimension_floor, max_iterations, require_human_approval, low_only_passes, models)
2. Present current values with defaults noted. For `plan_eval.*` and other non-review keys, display defaults since they are not yet enriched; mention that `set_config` is required to change them

### Change a config value

Allowed keys:
- `review.score_threshold` (default: 30) — minimum aggregate review score across 4 stages (8-40). 8 dimensions: Completeness, Accuracy, Design, Maintainability, Vulnerability, Hardening, EdgeCases, LogicCorrectness.
- `review.max_iterations` (default: 3) — max review retry cycles
- `review.required_changed_files` (default: 5) — file count triggering review requirement
- `review.dimension_floor` (default: 4) — minimum score per individual dimension (1-5). Any dimension below this floor blocks regardless of aggregate score.
- `review.low_only_passes` (default: false) — if true, when all findings are low severity only, accept review as PASS without further iteration
- `plan_eval.score_threshold` (default: 12) — minimum aggregate plan eval score (3-15)
- `plan_eval.max_iterations` (default: 2) — max plan eval retry cycles

1. Call `mcp__plugin_qult_qult__set_config({ key: "<key>", value: <number> })`
2. Confirm the change

### Reset config

1. For each config key, call `mcp__plugin_qult_qult__set_config({ key: "<key>", value: <default_value> })` with its default value
2. Confirm reset to defaults
