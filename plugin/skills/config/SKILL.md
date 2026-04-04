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
- "reset config" -> delete .qult/config.json to use defaults

## Steps

### Show current config

1. Call `mcp__plugin_qult_qult__get_session_status()` for current session state
2. Read `.qult/config.json` if it exists (via Read tool)
3. Present current values with defaults noted

### Change a config value

Allowed keys:
- `review.score_threshold` (default: 26) — minimum aggregate review score across 3 stages (6-30). 6 dimensions: Completeness, Accuracy, Design, Maintainability, Vulnerability, Hardening.
- `review.max_iterations` (default: 3) — max review retry cycles
- `review.required_changed_files` (default: 5) — file count triggering review requirement
- `review.dimension_floor` (default: 4) — minimum score per individual dimension (1-5). Any dimension below this floor blocks regardless of aggregate score.
- `plan_eval.score_threshold` (default: 10) — minimum aggregate plan eval score (3-15)
- `plan_eval.max_iterations` (default: 2) — max plan eval retry cycles

1. Call `mcp__plugin_qult_qult__set_config({ key: "<key>", value: <number> })`
2. Confirm the change

### Reset config

1. Delete `.qult/config.json` via Bash `rm .qult/config.json`
2. Confirm reset to defaults
