---
name: uninstall
description: "Show step-by-step instructions to fully remove qult from the user environment, including ~/.claude/rules/qult-*.md and ~/.qult/qult.db. Use when the architect wants to uninstall qult cleanly without leaving artifacts."
user-invocable: true
allowed-tools:
  - Bash
---

# /qult:uninstall

Cleanly remove qult and all of its artifacts from the user environment.

## Step 1: Inventory existing artifacts

Report what will be removed before touching anything. Run:

```bash
ls ~/.claude/rules/qult-*.md 2>/dev/null
test -d ~/.qult && echo "~/.qult exists ($(du -sh ~/.qult | cut -f1))" || echo "~/.qult does not exist"
```

Show the architect:
- Each rule file path that will be deleted
- The presence and size of `~/.qult/qult.db`
- Any `.qult/` directory in the current project (legacy from older qult versions)

## Step 2: Remove user-level rules

Ask the architect to confirm. Then run:

```bash
rm -f ~/.claude/rules/qult-*.md
```

Report each file removed.

## Step 3: Remove DB (optional)

Ask the architect: "Remove `~/.qult/qult.db` (contains session history, gate config, flywheel metrics)? This is irreversible."

If yes:

```bash
rm -rf ~/.qult
```

If the architect wants to preserve history (e.g. for re-install later), skip this step.

## Step 4: Remove the plugin itself

The plugin binary lives in Claude Code's plugin cache and is not removed by the steps above. Instruct:

```
/plugin                    →  delete qult
```

After plugin deletion, restart Claude Code.

## Step 5: Verify

```bash
ls ~/.claude/rules/qult-*.md 2>/dev/null && echo "rules still present" || echo "rules removed"
test -d ~/.qult && echo "DB still present" || echo "DB removed"
```

## Output

Report a summary:

```
Removed:
  - ~/.claude/rules/qult-workflow.md
  - ~/.claude/rules/qult-pre-commit.md
  - ~/.claude/rules/qult-plan-mode.md
  - ~/.claude/rules/qult-review.md
  - ~/.claude/rules/qult-quality.md
  - ~/.qult/ (DB and audit log)

Next steps:
  - Run /plugin → delete qult
  - Restart Claude Code
```

## What this skill does NOT do

- Does NOT remove the plugin binary (`/plugin` does that)
- Does NOT modify project files (no `.qult/` cleanup in the current project — that's `/qult:doctor`'s job)
- Does NOT touch `.claude/settings.local.json` or `.claude/settings.json` in the project
