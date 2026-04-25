---
name: update
description: "Refresh qult workflow rules in ~/.claude/rules/qult-*.md from the installed plugin cache. Run after `/plugin update qult` to pick up the latest rule content. Does NOT touch project state or registered gates."
user-invocable: true
allowed-tools:
  - Bash
---

# /qult:update

Refresh workflow rules from the installed plugin cache to `~/.claude/rules/`. Use after updating the qult plugin.

## Step 1: Confirm plugin is available

```bash
test -d "${CLAUDE_PLUGIN_ROOT}/rules" || { echo "qult plugin not found"; exit 1; }
```

## Step 2: Refresh rules

```bash
mkdir -p ~/.claude/rules
cp -f "${CLAUDE_PLUGIN_ROOT}/rules/"qult-*.md ~/.claude/rules/
```

`cp -f` **always overwrites** — the plugin's current rule contents become the source of truth.

## Step 3: Report

List each rule file copied with its basename, plus the plugin version:

```bash
cat "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" | jq -r '.version'
ls -1 ~/.claude/rules/qult-*.md | xargs -I {} basename {}
```

Output format:

```
qult rules updated to v<VERSION>:
  - qult-workflow.md
  - qult-pre-commit.md
  - qult-spec-mode.md
  - qult-review.md
  - qult-quality.md
```

If the user previously had `qult-plan-mode.md` (v0.x), remove it during this step:

```bash
rm -f ~/.claude/rules/qult-plan-mode.md
```

Remind the architect to reload Claude Code (or start a new session) so the updated rules take effect.
