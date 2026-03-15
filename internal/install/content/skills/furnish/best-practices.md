# Claude Code Configuration Best Practices

Reference material for the configure skill. Loaded on demand, not injected into every conversation.

## CLAUDE.md

- Keep concise — every line consumes context window
- Use headers and bullets for scannability
- Include: `## Stack`, `## Commands`, `## Structure`, `## Rules`
- Commands should be copy-pasteable
- Rules should be actionable ("use X" not "consider using X")
- Don't exceed ~200 lines (context cost)
- Don't duplicate README content

## Skills (SKILL.md)

Required frontmatter: `name`, `description`
Optional: `user-invocable`, `allowed-tools`, `model`, `context`, `agent`, `argument-hint`

- Keep skills focused — one skill, one purpose
- Use `context: fork` for heavy exploration/review skills
- Use `allowed-tools` for least-privilege tool access
- Reference MCP tools by full name: `mcp__server-name__tool-name`
- Add supporting files alongside SKILL.md for large reference material

## Rules (.claude/rules/*.md)

```yaml
---
paths:
  - "**/*.test.ts"
---
```

- `paths` — glob patterns that trigger this rule
- Rules without paths apply globally (like mini CLAUDE.md)
- Keep rules concise — injected into context on every match
- Don't duplicate CLAUDE.md content

## Hooks (hooks.json)

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{"type": "command", "command": "./my-hook.sh", "timeout": 5}]
    }]
  }
}
```

Event types: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, PreCompact, Stop
Hook types: command, http, prompt (LLM-gated), agent (multi-turn)

- Keep hooks fast (< 2s for synchronous)
- Use `matcher` to limit which tools trigger
- Hook output goes into context — keep it concise
- `type: "prompt"` uses Claude's fast model for smart gating

## Custom Agents (.claude/agents/*.md)

```yaml
---
name: my-agent
description: When to use this agent
tools: Read, Grep, Glob
maxTurns: 30
---
```

- Restrict tools to minimum needed (least privilege)
- Write clear instructions — agents don't have conversation history
- Include output format expectations

## MCP Servers (.mcp.json)

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./server.js"],
      "env": {"API_KEY": "..."}
    }
  }
}
```

- Use project-level `.mcp.json` for project-specific servers
- Set env vars in `env` field, not system-wide
- Tools namespaced: `mcp__server-name__tool-name`

## Memory (MEMORY.md)

- Lines after ~200 are truncated — keep concise
- Store: confirmed patterns, architectural decisions, user preferences
- Don't store: session-specific context, unverified conclusions, duplicates of CLAUDE.md
- Use `.claude/memory/` topic files for detailed notes, link from MEMORY.md
