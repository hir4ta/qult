---
name: alfred-review
description: >
  Full Claude Code utilization report for your project. Analyzes CLAUDE.md,
  skills, rules, hooks, MCP servers, and session history. Returns
  improvement suggestions backed by best practices.
user-invocable: true
allowed-tools: mcp__claude-alfred__review, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
context: fork
agent: general-purpose
---

Project utilization review.

## Steps

1. **[HOW]** Call review with project_path set to the current working directory
2. **[HOW]** Call knowledge with query="Claude Code best practices setup checklist"
3. **[HOW]** Call preferences with action="get" to understand user's context
4. **[WHAT]** Compare the review results against these criteria:
   - CLAUDE.md: exists, under 200 lines, has Commands/Rules/Structure sections
   - Skills: each has name, description, constraint-tagged steps, guardrails
   - Rules: each has paths field, actionable instructions
   - Hooks: timeout appropriate for event type, matcher not overly broad
   - Agent: has name, description, tools, model fields
5. **[Template]** Generate report in the format below

## Output

**Setup Score**: X/10 (based on features in use and quality)
**In Use**: [list of configured features]
**Missing**: [features not yet configured, with brief value explanation]
**Top 3 Improvements**: ordered by impact, each with:
  - What: specific change
  - Why: concrete benefit
  - How: one-line example or command

## Guardrails

- Do NOT suggest features the user has explicitly chosen not to use (check preferences)
- Do NOT give vague suggestions ("improve your hooks" → "add PreToolUse hook for lint: ...")
