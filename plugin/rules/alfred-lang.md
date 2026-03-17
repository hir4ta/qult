---
description: Output language for all alfred-generated content (specs, steering, knowledge, messages)
---

# Output Language

Use the language specified by the `ALFRED_LANG` environment variable for all generated content.

- Default: `en` (English) when `ALFRED_LANG` is not set
- Applies to: spec files, steering docs, knowledge entries, review comments, user-facing messages, dashboard text
- Does NOT apply to: template headings (## Purpose, ## Goal, FR-N, DEC-N etc.), code identifiers, CLI output, commit messages
- When spawning agents, the agent inherits the same environment — no special handling needed

Example values: `en`, `ja`, `zh`, `ko`, `fr`, `de`, `es`, `pt`

Check with: `echo $ALFRED_LANG` — if empty, use English.
