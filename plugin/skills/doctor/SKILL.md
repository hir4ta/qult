---
name: doctor
description: Check qult health for the current project. Verifies state files, gates, and MCP server connectivity. Use when hooks don't fire, gates seem broken, or after initial setup to confirm everything works. NOT for checking session progress (use /qult:status instead).
user-invocable: true
---

# /qult:doctor

Diagnose qult setup issues in the current project.

## Checks

1. **`.qult/` directory**: Exists with `.state/` subdirectory
2. **Gates**: `.qult/gates.json` exists and has at least one gate in `on_write` or `on_commit`
3. **Plugin hooks**: Verify `hooks.json` exists at `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` via Bash: `test -f "${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json" && echo OK || echo FAIL`
4. **Fallback hooks**: Check if `.claude/settings.local.json` has qult hook entries. Report as `[INFO]` if present (fallback active) or `[INFO]` if absent (plugin-only mode)
5. **Legacy files**: Warn if any of these exist — suggest running `/qult:init` to clean up:
   - `.qult/hook.mjs` (old standalone hook)
   - `.claude/rules/qult-gates.md` (replaced by MCP instructions)
   - `.claude/rules/qult-quality.md` (replaced by MCP instructions)
   - `.claude/rules/qult-plan.md` (replaced by MCP instructions)
   - `.claude/rules/qult.md` (old single rule file)
   - Old settings.local.json hook entries containing `.qult/hook.mjs`
6. **MCP server**: Call `mcp__plugin_qult_qult__get_gate_config()` to verify the MCP server is responding
7. **Pending fixes**: Call `mcp__plugin_qult_qult__get_pending_fixes()` to check for stale errors
8. **Session state**: Call `mcp__plugin_qult_qult__get_session_status()` to verify state tracking works

## Output format

Report each check as OK, INFO, WARN, or FAIL with details:
```
[OK] .qult/.state/ directory exists
[OK] gates.json: 2 on_write, 1 on_commit gates
[OK] plugin active (skills accessible)
[INFO] fallback hooks: not registered (plugin-only mode). Run /qult:register-hooks if hooks don't fire.
[WARN] legacy file: .claude/rules/qult-gates.md exists — run /qult:init to clean up
[OK] MCP server responding
```

## Fix suggestions

For each issue, suggest the fix:
- Missing `.qult/`: Run `/qult:init`
- Missing gates: Run `/qult:init`
- Legacy files: Run `/qult:init` (cleans up automatically)
- Hooks not firing: Run `/qult:register-hooks`
- MCP not responding: Check plugin is enabled via `/plugin`
