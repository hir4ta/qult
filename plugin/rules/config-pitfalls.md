---
description: Common Claude Code configuration mistakes to avoid
paths:
  - "**/.claude/**"
  - "**/plugin/**"
---

# Common Configuration Pitfalls

## Skills
- `allowed-tools` must list only tools the skill actually needs (least-privilege)
- MCP tools must use fully qualified names: `mcp__<server>__<tool>` not just `<tool>`
- `context: fork` loses the current conversation context — only use for heavy/parallel workflows
- `disable-model-invocation: true` prevents Claude from auto-triggering — use for manual-only skills

## Rules
- Rules without `paths` load on EVERY session — keep them concise and broadly applicable
- Path-scoped rules trigger on file access, not every tool use
- Avoid overlapping rules that give contradictory instructions

## Agents
- Set `maxTurns` to prevent runaway agents
- Use `disallowedTools` for read-only agents instead of only specifying allowed tools
- `permissionMode: plan` makes agents read-only (cannot modify files)
- Omit `model:` to inherit the parent model (avoids separate API calls and rate limits)

## Hooks
- Never store secrets in hooks.json — use environment variables
- Test hooks manually with `echo '{}' | alfred hook <event>` before deploying
