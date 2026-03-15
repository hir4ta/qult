---
description: Constraints and best practices when editing hooks.json
paths:
  - "**/.claude/hooks.json"
  - "hooks.json"
---

# Hooks Guidelines

## Timeout Constraints

Hook timeouts are enforced by Claude Code — exceeding them causes SIGTERM:

| Event | Max Timeout | Notes |
|---|---|---|
| PreToolUse | 2s | No I/O, no DB — pure string matching only |
| UserPromptSubmit | 10s | Voyage semantic search (embed + vector search + rerank) |
| SessionStart | 5s | CLAUDE.md ingestion + spec context injection |
| PreCompact | 10s | Transcript parsing + decision extraction + session.md rebuild |

- Set internal timeouts slightly UNDER the external timeout (e.g., 4500ms for a 5s hook) to allow graceful cleanup
- Hook handlers MUST fail-open: never block Claude Code on errors
- Use `statusMessage` for every hook to give users feedback

## Matchers

- PreToolUse: scope with tool name matchers (e.g., `"Edit|Write|MultiEdit"`) to avoid unnecessary invocations
- Keep matcher patterns minimal — broad matchers waste resources

## General

- Hooks are short-lived processes — avoid Voyage API calls in the critical path (except UserPromptSubmit which is designed for it)
- Offload slow work to background processes (`cmd.Start()` + `cmd.Process.Release()`)
- Always include a top-level `description` field in hooks.json
