---
name: alfred-create-hook
description: >
  Generate Claude Code hook configuration and handler script following
  latest best practices and the user's preferences.
user-invocable: true
argument-hint: "[event-name]"
allowed-tools: Read, Write, Edit, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create a new Claude Code hook.

## Steps

1. **[HOW]** Call preferences with action="get" for user preferences
2. **[HOW]** Ask the user:
   - "Which event?" (PreToolUse, PostToolUse, SessionStart, UserPromptSubmit, Stop, etc.)
   - "What should the hook do?" (free text)
   - "Should it block on failure?" (yes for PreToolUse gates, no for async)
3. **[HOW]** Read existing .claude/hooks.json or settings.json hooks section if present
4. **[Template]** Generate hook configuration using the template below
5. **[WHAT]** Validate:
   - timeout: ≤ 5s for PreToolUse (blocks workflow), ≤ 30s for others
   - matcher: regex that matches only intended tools (not overly broad)
   - Handler type: command for scripts, prompt for AI-powered checks, http for webhooks
   - If PreToolUse: non-zero exit must have a clear, helpful error message
6. **[HOW]** Write/update hooks configuration and handler script
7. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated hook in a separate context:
   - Prompt: "Read the generated hook config and handler script. Check: (1) timeout appropriate for event type (≤5s for PreToolUse), (2) matcher not overly broad, (3) handler script is executable, (4) PreToolUse hooks have clear error messages on failure, (5) call mcp__claude-alfred__knowledge with query='Claude Code hook best practices timeout matcher' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template (hooks.json entry)

```json
{
  "EventName": [{
    "matcher": "ToolPattern",
    "hooks": [{
      "type": "command",
      "command": ".claude/scripts/hook-name.sh",
      "timeout": 5
    }]
  }]
}
```

## Available Hook Types

- command: Shell script (default, most common)
- prompt: AI-powered check using a model prompt
- agent: Full agent with tools for complex validation
- http: POST to external URL

## Guardrails

- Do NOT set timeout > 5s for PreToolUse hooks (blocks user workflow)
- Do NOT use overly broad matchers (e.g. ".*" catches everything)
- Do NOT forget to make handler scripts executable (chmod +x)
