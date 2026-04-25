---
name: uninstall
description: "Cleanly remove qult — user rules at ~/.claude/rules/qult-*.md, legacy ~/.qult/qult.db (v0.x SQLite), and any project-local .qult/ if the architect chooses. Use to fully uninstall."
user-invocable: true
allowed-tools:
  - Bash
---

# /qult:uninstall

Remove qult and its artifacts from the architect's environment.

## Step 1: Inventory

```bash
ls ~/.claude/rules/qult-*.md 2>/dev/null
test -d ~/.qult && echo "~/.qult exists (legacy v0.x SQLite)"
test -d .qult && echo ".qult/ exists in this project (specs + state)"
```

Show the architect:
- Each user-level rule file
- Whether `~/.qult/` (v0.x) is present
- Whether the current project has `.qult/` and how many specs are under `.qult/specs/`

## Step 2: Remove user-level rules (always)

```bash
rm -f ~/.claude/rules/qult-*.md
```

Report each file removed.

## Step 3: Remove legacy v0.x SQLite store (if present)

```bash
test -d ~/.qult && rm -rf ~/.qult && echo "removed legacy ~/.qult/" || echo "no legacy ~/.qult/"
```

This is safe — qult does not use `~/.qult/`.

## Step 4: Project-local `.qult/` (ask first)

If `.qult/specs/` has committed spec markdown, this is **part of the repo's history**. Removing it deletes future visibility into past specs.

Ask the architect: "Remove this project's `.qult/` directory? This deletes spec markdown (committed) and state (uncommitted)."

- **If keep** (recommended): do nothing. Spec docs survive uninstall.
- **If remove**: `rm -rf .qult/`. Then `git rm -r .qult/specs/ && git commit -m "<conventional>: remove qult spec history"`.

## Step 5: Remove the plugin binary

The plugin cache is managed by Claude Code:

```
/plugin   →   uninstall qult
```

Then restart Claude Code.

## Step 6: Verify

```bash
ls ~/.claude/rules/qult-*.md 2>/dev/null && echo "rules still present" || echo "rules removed"
test -d ~/.qult && echo "legacy DB still present" || echo "legacy DB absent"
```

## Output

```
Uninstall summary:
  ✓ user rules removed (5 files)
  ✓ legacy ~/.qult/ removed (or "absent")
  ✓ project .qult/ kept (or "removed")
  → next: /plugin → uninstall qult, then restart Claude Code
```

## What this skill does NOT do

- Does NOT remove the plugin cache binary (`/plugin` handles that).
- Does NOT modify `.claude/settings.json` / `.claude/settings.local.json` — review those manually if you had qult-specific entries.
- Does NOT undo the user-level git config changes set by other tools.
