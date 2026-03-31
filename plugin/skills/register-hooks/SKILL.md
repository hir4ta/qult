---
name: register-hooks
description: "Register qult hooks in .claude/settings.local.json as a fallback. Use when plugin hooks don't fire (VS Code, some environments). NOT needed if hooks already work via plugin."
user_invocable: true
---

# /qult:register-hooks

Register qult hooks in `.claude/settings.local.json` as a fallback for environments where plugin hooks don't fire reliably.

## When to use

- Hooks don't fire in VS Code Desktop ([#18547](https://github.com/anthropics/claude-code/issues/18547))
- `/qult:doctor` reports hooks not working
- After running `/qult:init`, gates are configured but hooks never trigger

## When NOT to use

- Hooks are already working (plugin hooks are firing correctly)
- You want to keep your settings.local.json clean

## Steps

1. **Read** `.claude/settings.local.json` (create if missing, start with `{}`)
2. **Merge** qult hook entries into the existing `hooks` object. Preserve any non-qult hooks and other keys already in the file.
3. **Write** the updated file back

The hooks to register:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs post-tool",
            "timeout": 15
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|Bash|ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs pre-tool",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs stop",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs subagent-stop",
            "timeout": 5
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs task-completed",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Note: These use `${CLAUDE_PLUGIN_ROOT}` so the binary stays in the plugin cache — no file copy needed. When plugin hooks work, these are deduplicated (same command = runs once).

## Output

Confirm: `qult hooks registered in .claude/settings.local.json (5 events). Restart Claude Code for hooks to take effect.`

## Unregister

To remove fallback hooks, edit `.claude/settings.local.json` and delete the qult hook entries (commands containing `hook.mjs`). Or delete the file if it only contains qult hooks.
