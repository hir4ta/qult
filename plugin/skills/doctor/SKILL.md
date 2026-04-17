---
name: doctor
description: Check qult health for the current project. Verifies state files, gates, rules installation, and MCP server connectivity. Use after initial setup or when something seems broken. NOT for checking session progress (use /qult:status instead).
user-invocable: true
---

# /qult:doctor

Diagnose qult setup issues in the current project.

## Checks

1. **DB connectivity**: Call `mcp__plugin_qult_qult__get_session_status()` to verify SQLite DB at `~/.qult/qult.db` is accessible
2. **Gates**: Call `mcp__plugin_qult_qult__get_gate_config()` to verify at least one gate in `on_write` or `on_commit`
3. **Rules installation**: Verify each rule file exists at `~/.claude/rules/qult-*.md` (workflow, pre-commit, plan-mode, review, quality). If any are missing, suggest re-running `/qult:init`. Check via Bash: `ls ~/.claude/rules/qult-*.md 2>/dev/null | wc -l`
4. **Plugin assets**: Verify `${CLAUDE_PLUGIN_ROOT}/rules/` exists via Bash: `test -d "${CLAUDE_PLUGIN_ROOT}/rules" && echo OK || echo FAIL`
5. **Legacy files**: Warn if any of these exist — suggest running `/qult:init` to clean up:
   - `.qult/` directory (state lives in `~/.qult/qult.db`. Safe to delete)
   - `.claude/rules/qult.md` (old single rule file from pre-rules-migration)
   - `.claude/rules/qult-gates.md` (replaced by user-level rules)
   - `.claude/rules/qult-quality.md` (now at `~/.claude/rules/qult-quality.md` — local copy obsolete)
   - `.claude/rules/qult-plan.md` (now at `~/.claude/rules/qult-plan-mode.md`)
   - Old settings.local.json hook entries containing `.qult/hook.mjs` or `dist/hook.mjs`
6. **MCP server**: Call `mcp__plugin_qult_qult__get_gate_config()` to verify the MCP server is responding
7. **Pending fixes**: Call `mcp__plugin_qult_qult__get_pending_fixes()` to check for stale errors

## Output format

Report each check as OK, INFO, WARN, or FAIL with details:
```
[OK]   DB connectivity: ~/.qult/qult.db accessible
[OK]   gates: 2 on_write, 1 on_commit
[OK]   rules: 5/5 installed at ~/.claude/rules/qult-*.md
[OK]   plugin assets: ${CLAUDE_PLUGIN_ROOT}/rules/ exists
[WARN] legacy: .qult/ directory exists — no longer needed, safe to delete
[OK]   MCP server responding
[OK]   pending fixes: none
```

## Fix suggestions

For each issue, suggest the fix:
- DB not accessible: Run `/qult:init`
- Missing gates: Run `/qult:init`
- Missing rules: Run `/qult:init` (it always overwrites rules with the latest)
- Plugin assets missing: Reinstall the plugin via `/plugin install qult@hir4ta-qult`
- Legacy `.qult/` directory exists: Safe to delete (`rm -rf .qult/`)
- Legacy files: Run `/qult:init` (cleans up automatically)
- MCP not responding: Check plugin is enabled via `/plugin`
