---
name: init
description: "Initialize qult for the current user. Installs workflow rules to ~/.claude/rules/qult-*.md and cleans up any legacy files from older qult versions. Idempotent — safe to run multiple times. Run once after installing the qult plugin."
user-invocable: true
allowed-tools:
  - Bash
  - mcp__plugin_qult_qult__get_session_status
---

# /qult:init

Install qult workflow rules and clean up legacy files. Idempotent — safe to re-run.

## Step 1: Verify plugin + DB are reachable

Check the plugin cache path exists, then call `mcp__plugin_qult_qult__get_session_status` to confirm the MCP server and DB are reachable.

```bash
test -d "${CLAUDE_PLUGIN_ROOT}/rules" || { echo "qult plugin rules missing — reinstall the plugin"; exit 1; }
```

If the MCP call fails, check that Bun is installed and the qult plugin is loaded.

## Step 2: Install user-level rules

```bash
mkdir -p ~/.claude/rules
cp -f "${CLAUDE_PLUGIN_ROOT}/rules/"qult-*.md ~/.claude/rules/
```

**Always overwrites** — the plugin's current rules become the source of truth.

## Step 3: Clean up legacy files (if any)

Remove if they exist (from older qult versions):
- `.qult/` directory in the current project (state lives in `~/.qult/qult.db`)
- `.claude/rules/qult.md` (old single rule file)
- Any project-local `.claude/rules/qult-*.md` (rules moved to user level)
- Old `.claude/settings.local.json` hook entries referencing `.qult/hook.mjs` or `dist/hook.mjs`
- `.qult/` line in `.gitignore`

## Output

```
qult initialized:
  DB: ~/.qult/qult.db — connected
  Rules: N installed at ~/.claude/rules/qult-*.md (plugin vX.Y)
  Legacy cleanup: (list removed items, or "none")
```

Remind the architect to reload Claude Code (or start a new session) so the rules take effect.

---

**Note**: qult no longer detects project toolchain at init time. Reviewers and skills read `package.json` / `Cargo.toml` / `pyproject.toml` etc. on demand. If you update qult itself, run `/qult:update` to refresh rules only.
