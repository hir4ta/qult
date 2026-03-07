---
paths:
  - "**/.claude/skills/**"
  - "**/SKILL.md"
---

# Skills Best Practices

Skills are reusable prompt templates that Claude Code executes on demand.

## SKILL.md Frontmatter
Required fields:
- `name` — kebab-case identifier (e.g., `my-skill`)
- `description` — when Claude should auto-invoke this skill

Optional fields:
- `user-invocable: true` — allows `/skill-name` invocation
- `allowed-tools` — comma-separated list of tools the skill can use
- `context: fork` — runs in a forked context (isolated from main conversation)
- `agent` — agent type for forked context (`general-purpose`, `Explore`, etc.)

## Content Structure
1. Brief description of what the skill does
2. `## Steps` — numbered steps the skill follows
3. `## Output` — expected output format
4. `## Important Notes` — edge cases, constraints

## Tips
- Keep skills focused — one skill, one purpose
- Use `context: fork` for skills that do heavy exploration
- Reference MCP tools by full name: `mcp__server-name__tool-name`
- Skills with `user-invocable: false` are auto-invoked by Claude when the description matches
