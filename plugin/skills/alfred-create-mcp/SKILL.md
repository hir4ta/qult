---
name: alfred-create-mcp
description: >
  Configure a new MCP server in the project's .mcp.json following
  latest best practices.
user-invocable: true
argument-hint: "[server-name]"
allowed-tools: Read, Write, Edit, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Configure a new MCP server.

## Steps

1. **[HOW]** Ask the user:
   - "What MCP server do you want to add?" (name or npm package)
   - "Is it a local command or remote SSE server?" (stdio/sse)
2. **[HOW]** Read existing .mcp.json if present
3. **[Template]** Add the server configuration using the template below
4. **[WHAT]** Validate:
   - command: points to an executable that exists or will be installed
   - env: API keys use environment variables, not hardcoded values
   - Tool namespace: will be mcp__<server-name>__<tool-name>
5. **[HOW]** Write/update .mcp.json
6. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated config in a separate context:
   - Prompt: "Read .mcp.json and validate the new MCP server entry. Check: (1) command path exists or is a known package, (2) no hardcoded API keys (must use env vars), (3) args array is valid, (4) call mcp__claude-alfred__knowledge with query='Claude Code MCP server configuration best practices' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "<executable>",
      "args": ["<arg1>", "<arg2>"],
      "env": {
        "API_KEY": "${API_KEY}"
      }
    }
  }
}
```

## Guardrails

- Do NOT hardcode API keys in .mcp.json — use environment variables
- Do NOT add servers without verifying the command exists
