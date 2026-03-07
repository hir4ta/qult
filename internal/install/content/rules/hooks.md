---
paths:
  - "**/.claude/hooks/**"
  - "**/hooks.json"
---

# Hooks Best Practices

Hooks run shell commands in response to Claude Code lifecycle events.

## Event Types
- `PreToolUse` — before a tool executes (can block with non-zero exit)
- `PostToolUse` — after a tool succeeds
- `PostToolUseFailure` — after a tool fails
- `UserPromptSubmit` — when user sends a message
- `SessionStart` — on session start/resume/compact
- `SessionEnd` — on session end
- `PreCompact` — before context compaction

## Hook Configuration (hooks.json)
```json
{
  "PreToolUse": [{
    "matcher": "Edit|Write",
    "hooks": [{
      "type": "command",
      "command": "./my-hook.sh",
      "timeout": 5
    }]
  }]
}
```

## Key Concepts
- `matcher` — regex to filter which tools trigger the hook
- `timeout` — seconds before the hook is killed (default: 60)
- `async: true` — hook runs in background, doesn't block
- Hooks receive event data via stdin (JSON)
- stdout is injected as `additionalContext` into the conversation
- Non-zero exit code on `PreToolUse` blocks the tool execution

## Tips
- Keep hooks fast (< 2s for synchronous hooks)
- Use `async: true` for data collection that doesn't need to block
- Use `matcher` to limit which tools trigger the hook
- Hook output goes into context — keep it concise
