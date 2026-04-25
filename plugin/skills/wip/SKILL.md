---
name: wip
description: "Create a `[wave-NN] wip: <message>` commit during the current Wave. Use freely while implementing tasks; the final /qult:wave-complete will record the whole range. Skill exists to enforce the prefix."
---

# /qult:wip

Create a WIP commit with the proper Wave prefix.

## Steps

1. `mcp__plugin_qult_qult__get_active_spec`. Refuse if null. From its `current_wave`, derive the prefix `[wave-NN]` (2-digit zero-padded).
2. Run `git status --short` to confirm there are staged or unstaged changes. Refuse with "no changes to commit" if clean.
3. Compose a message:
   - User passed `$ARGUMENTS` non-empty → `[wave-NN] wip: <ARGUMENTS>` (truncate to 72 chars on the subject line).
   - Otherwise → ask the architect for a one-line message (or accept "auto", in which case generate from the staged diff).
4. Show the message to the architect for confirmation. **Do not auto-commit.**
5. After confirmation: `git add -A && git commit -m "<message>"`.

## Don'ts

- Don't enable signing / disable hooks here. Use the project's existing git config.
- Don't squash. Wave commits are range-based.
- Don't generate messages that include literal `[wave-NN]` for any other Wave than the active one.
