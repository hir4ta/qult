---
paths:
  - "**/.mcp.json"
  - "**/.claude/mcp.json"
---

# MCP Server Configuration Best Practices

MCP (Model Context Protocol) servers extend Claude Code with custom tools, resources, and prompts.

## Configuration File
`.mcp.json` (project-level) or `.claude/mcp.json`:
```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./mcp-server.js"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

## Transport Types
- `stdio` — most common, communicates via stdin/stdout
- `sse` — Server-Sent Events for remote servers

## Tips
- Use project-level `.mcp.json` for project-specific servers
- Use `~/.claude/mcp.json` for global servers (personal tools)
- Set environment variables in `env` field, not system-wide
- MCP tools are namespaced: `mcp__server-name__tool-name`
- Servers start on demand and persist for the session
- Use `claude mcp add` CLI command for interactive setup
