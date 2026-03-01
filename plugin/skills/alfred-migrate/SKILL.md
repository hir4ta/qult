---
name: alfred-migrate
description: >
  Compare your current Claude Code setup against latest best practices
  and generate migration suggestions. Shows what's outdated and how to update.
user-invocable: true
allowed-tools: Read, Glob, Bash, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__review, mcp__claude-alfred__preferences
context: fork
agent: general-purpose
---

Setup migration advisor.

## Steps

1. **[HOW]** Call review with project_path to get current setup analysis
2. **[HOW]** Call knowledge with query="Claude Code latest features changelog new capabilities"
3. **[WHAT]** Compare current setup against latest best practices:
   - Skills: have constraint-type tags? argument-hint? guardrails section?
   - Hooks: using new event types (Stop, ConfigChange, prompt/agent handler types)?
   - Agents: have maxTurns, memory, skills preloading?
   - CLAUDE.md: using @imports? Under 200 lines?
4. **[HOW]** Call preferences with action="get" to filter by user preferences
5. **[Template]** Generate migration plan

## Output

**Available Updates** (ordered by impact):
1. [feature]: [current state] → [recommended state]
   - How: [specific change]

## Guardrails

- Do NOT suggest changes that would break existing workflows
- Do NOT include changes the user has explicitly rejected (check preferences)
