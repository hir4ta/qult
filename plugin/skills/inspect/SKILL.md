---
name: inspect
description: >
  Full Claude Code utilization report for your project. Analyzes CLAUDE.md,
  skills, rules, hooks, MCP servers, and session history. Returns improvement
  suggestions backed by best practices. Includes quick audit and migration checks.
user-invocable: true
argument-hint: "[--quick]"
allowed-tools: Read, Glob, mcp__alfred__review, mcp__alfred__knowledge, mcp__alfred__preferences
context: fork
agent: general-purpose
---

The butler's rounds — inspect the estate and report what needs attention.

## Steps

1. **[HOW]** Load context:
   - Call `preferences` with action="get" to understand the user's style
   - Call `review` with project_path=$CWD for current setup analysis

2. **[WHAT]** If $ARGUMENTS contains "--quick":
   - Output a checklist only: `[x] CLAUDE.md (N lines)`, `[ ] Hooks (not configured)`, etc.
   - One-line suggestion for each missing item
   - STOP here

3. **[HOW]** Deep analysis:
   - Call `knowledge` with query about latest best practices and setup checklist
   - Compare current setup against best practices:
     - CLAUDE.md: presence, length (<200 lines), required sections (Stack, Commands, Rules)
     - Skills: constraint tags (HOW/WHAT), guardrails section, tool least-privilege
     - Rules: valid glob patterns, actionable instructions, concise (<20 lines)
     - Hooks: timeout appropriateness, matcher specificity
     - Agents: model explicit, tools minimal, description explains WHEN to delegate
     - MCP: no hardcoded API keys, valid commands

4. **[WHAT]** Migration check:
   - Identify outdated patterns (missing constraint tags, deprecated fields, new event types)
   - Flag features available in current CC version but not yet adopted

5. **[Template]** Output format:
   ```
   ## Setup Score: N/10

   ### In Use
   - ...

   ### Needs Attention (ordered by impact)
   1. **[HIGH]** What — Why — How to fix
   2. **[MEDIUM]** ...

   ### Migration Opportunities
   - ...
   ```

## Guardrails

- Do NOT suggest changes that conflict with user preferences
- Do NOT report LOW severity or PASS items — only actionable findings
- Do NOT read file contents unless checking specific patterns; rely on review MCP tool
- Keep report under 30 lines unless user asks for detail
