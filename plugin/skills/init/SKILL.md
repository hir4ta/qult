---
name: init
description: Set up qult quality gates for the current project. Creates .qult/ directory, detects gates, and places rules files.
user_invocable: true
---

# /qult:init

Set up qult for this project. Run this once per project.

## Steps

1. **Create `.qult/.state/` directory** if it doesn't exist
2. **Detect gates**: Run `/qult:detect-gates` to auto-detect lint, typecheck, and test tools
3. **Place rules files** in `Project/.claude/rules/` — use the exact content from `/qult:update` skill
4. **Add `.qult/` to `.gitignore`** if not already present
5. **Clean up legacy files**: Check for and remove old `~/.claude/skills/qult-*`, `~/.claude/agents/qult-*`, `~/.claude/rules/qult-*`, and `Project/.claude/rules/qult.md` (old name, now `qult-gates.md`)
6. **Clean up legacy hook registration**: If `.claude/settings.local.json` exists, remove any qult hook entries (commands containing `.qult/hook.mjs`) from the `hooks` object. Remove `.qult/hook.mjs` if it exists. These are no longer needed — hooks are now provided by the plugin.

## Output

Confirm each step was completed successfully.

After init, suggest: "If hooks don't fire in VS Code or your environment, run `/qult:register-hooks` to register them in settings.local.json as a fallback."
