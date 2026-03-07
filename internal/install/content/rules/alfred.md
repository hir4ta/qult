# alfred MCP Tools

alfred's knowledge base contains Claude Code docs and best practices.
Do NOT proceed with .claude/ configuration tasks by only reading files.

## knowledge — Search docs and best practices

**Auto-consult on every user prompt:** If the user's question or task likely relates to Claude Code, call knowledge BEFORE responding. This includes:
- Claude Code features (hooks, skills, rules, agents, MCP, memory, CLAUDE.md)
- Creating, modifying, or reviewing `.claude/` configuration files

When in doubt, call knowledge — it's fast and the cost of missing relevant context is higher than an extra search.

## review — Analyze project's Claude Code utilization

CALL FIRST when:
- Reviewing or auditing `.claude/` configuration (agents, skills, rules, hooks, MCP)
- Evaluating CLAUDE.md quality or looking for improvements
- Checking overall Claude Code setup health for a project

## suggest — Suggest .claude/ config changes based on code changes

USE when:
- After code changes, to check if .claude/ configuration needs updating
- When reviewing whether project setup is still aligned with current code
