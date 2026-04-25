---
name: init
description: "Initialize qult for the current project. Bootstraps .qult/ (specs/ + state/ + config.json), installs user-level workflow rules to ~/.claude/rules/qult-*.md, manages .gitignore, and removes the legacy ~/.qult/qult.db SQLite store. Idempotent — safe to re-run."
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - mcp__plugin_qult_qult__get_project_status
---

# /qult:init

Bootstrap qult for the project.

## Step 1: Verify the plugin is reachable

```bash
test -d "${CLAUDE_PLUGIN_ROOT}/rules" || { echo "qult plugin rules missing — reinstall the plugin"; exit 1; }
```

Then call `mcp__plugin_qult_qult__get_project_status` to confirm the MCP server is alive.

## Step 2: Bootstrap `.qult/`

Create the project-local layout:

```bash
mkdir -p .qult/specs/archive .qult/state
```

Generate `.qult/config.json` if missing (the plugin ships sensible defaults; this file is only created when overrides are needed):

```bash
test -f .qult/config.json || cat > .qult/config.json <<'JSON'
{
  "review": { "score_threshold": 30, "dimension_floor": 4 }
}
JSON
```

## Step 3: Manage `.gitignore`

The rule is: **`.qult/specs/` and `.qult/config.json` MUST be tracked, `.qult/state/` MUST NOT.**

Read `.gitignore` (create if missing). Apply the following logic:

1. If a broad rule like `^\.qult/?$` or `^/?\.qult/\*?$` is present (ignores everything under `.qult/`), insert `!.qult/specs/` and `!.qult/config.json` negations after it. Warn the architect that the broad rule is dangerous.
2. Otherwise, append `.qult/state/` to the file (if not already present).
3. Never write `.qult/` (without trailing `state/`) — that would hide spec markdown which is the source of truth.

## Step 4: Install user-level workflow rules

```bash
mkdir -p ~/.claude/rules
cp -f "${CLAUDE_PLUGIN_ROOT}/rules/"qult-*.md ~/.claude/rules/
```

Always overwrites — plugin rules are authoritative.

## Step 5: Remove legacy v0.x state

```bash
test -f ~/.qult/qult.db && rm -f ~/.qult/qult.db ~/.qult/qult.db-shm ~/.qult/qult.db-wal && rmdir ~/.qult 2>/dev/null || true
test -f .claude/rules/qult.md && rm -f .claude/rules/qult.md
test -d .claude/rules && find .claude/rules -name 'qult-*.md' -delete
```

If the project's `.claude/settings.local.json` references `.qult/hook.mjs` or `dist/hook.mjs`, surface a warning — those v0.x hooks are no longer used and should be removed manually.

## Output

```
qult initialized:
  Project state:    .qult/{specs/, state/, config.json}
  Rules installed:  N files in ~/.claude/rules/qult-*.md
  .gitignore:       <added | already-present | conflict-resolved>
  Legacy removed:   (list, or "none")
```

Remind the architect to reload Claude Code so the rules take effect.
