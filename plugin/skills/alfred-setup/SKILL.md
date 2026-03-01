---
name: alfred-setup
description: >
  Interactive wizard to set up Claude Code best practices for your project.
  Creates CLAUDE.md, hooks, skills, rules, and MCP configuration step by step.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences, mcp__claude-alfred__review
---

Project setup wizard.

## Steps

1. **[HOW]** Call review with project_path to assess current setup
2. **[HOW]** Call preferences with action="get" for user preferences
3. **[HOW]** Show current setup status and ask what to configure:
   - AskUserQuestion with multiSelect: CLAUDE.md, Skills, Rules, Hooks, MCP, Memory
4. **[HOW]** For each selected item, run the corresponding create flow:
   - Each create flow follows its own skill's template and validation
5. **[WHAT]** After all items created, call review again and verify:
   - Setup score improved
   - No configuration conflicts (e.g. hook and rule targeting same concern)

## Guardrails

- Do NOT create all items without user selection — let them choose
- Do NOT skip validation steps from individual create skills
