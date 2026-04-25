---
name: doctor
description: Check qult health: .qult/ layout, gitignore correctness, rules installation, MCP server connectivity, and absence of legacy v0.x state. Use after `/qult:init` or when something seems broken.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - mcp__plugin_qult_qult__get_project_status
  - mcp__plugin_qult_qult__get_pending_fixes
---

# /qult:doctor

Diagnose qult setup.

## Checks

1. **`.qult/` layout**: verify directory structure
   ```bash
   for d in .qult/specs .qult/specs/archive .qult/state; do
       test -d "$d" && echo "[OK]  $d" || echo "[FAIL] $d missing"
   done
   test -f .qult/config.json && echo "[OK]  config.json" || echo "[INFO] config.json not present (defaults in use)"
   ```
2. **`.gitignore` correctness**:
   - `.qult/state/` MUST be ignored.
   - `.qult/specs/` and `.qult/config.json` MUST NOT be ignored.
   ```bash
   git check-ignore -q .qult/state/current.json && echo "[OK]  state ignored" || echo "[FAIL] state NOT ignored — secrets may leak"
   git check-ignore -q .qult/specs/foo/requirements.md 2>/dev/null && echo "[FAIL] specs accidentally ignored — broad .qult/ rule?" || echo "[OK]  specs tracked"
   ```
3. **No state in git**: `.qult/state/*.json` should never appear in `git ls-files`.
   ```bash
   git ls-files .qult/state/ | head -1 && echo "[WARN] state files were force-added to git — consider 'git rm --cached'" || echo "[OK]  no state files tracked"
   ```
4. **Rules installation**: 5 files at `~/.claude/rules/qult-*.md` (`qult-workflow.md`, `qult-pre-commit.md`, `qult-spec-mode.md`, `qult-review.md`, `qult-quality.md`).
   ```bash
   ls ~/.claude/rules/qult-*.md 2>/dev/null | wc -l
   ```
5. **Plugin assets**: `test -d "${CLAUDE_PLUGIN_ROOT}/rules"`.
6. **MCP server**: `mcp__plugin_qult_qult__get_project_status` round-trips successfully.
7. **No legacy v0.x state**:
   - `~/.qult/qult.db` should NOT exist (v0.x SQLite store).
   - `.claude/rules/qult-plan-mode.md` (project-local) should NOT exist (rule moved to user level + renamed).
   - `.claude/rules/qult.md` should NOT exist (old single-rule format).
8. **Pending fixes** (info only): `mcp__plugin_qult_qult__get_pending_fixes`.

## Output

```
qult doctor:
  [OK]   .qult/{specs,state,specs/archive} present
  [OK]   config.json defaults
  [OK]   .gitignore: state ignored, specs tracked
  [OK]   no state files in git
  [OK]   rules: 5/5 installed
  [OK]   plugin assets present
  [OK]   MCP server responding
  [OK]   no legacy v0.x state
  [INFO] pending fixes: 0
```

## Fix suggestions

| Symptom | Action |
|---|---|
| `.qult/` layout missing | Run `/qult:init` |
| `.gitignore` ignores specs | Edit `.gitignore`: add `!.qult/specs/` and `!.qult/config.json` after the broad `.qult/` rule |
| State files tracked in git | `git rm --cached .qult/state/*.json && git commit` |
| Rules missing | Run `/qult:init` (always overwrites with the plugin's current rules) |
| `~/.qult/qult.db` exists | `rm -f ~/.qult/qult.db ~/.qult/qult.db-shm ~/.qult/qult.db-wal && rmdir ~/.qult` (no-op) |
| MCP not responding | `/plugin` to confirm qult is enabled; check Bun is installed |
