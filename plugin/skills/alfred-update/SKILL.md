---
name: alfred-update
description: >
  Update an existing Claude Code configuration file (skill, rule, hook, agent,
  CLAUDE.md, memory) against latest best practices. Reads the current file,
  compares with knowledge base, proposes improvements, and validates in a
  separate review context.
user-invocable: true
argument-hint: "<type> [name]  (e.g. skill my-skill, rule go-errors, claude-md)"
allowed-tools: Read, Write, Edit, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Update an existing Claude Code configuration file.

## Steps

1. **[HOW]** Parse $ARGUMENTS to determine target type and name:
   - Valid types: skill, rule, hook, agent, claude-md, memory, mcp
   - If no arguments, ask with AskUserQuestion: "What do you want to update?" (skill/rule/hook/agent/claude-md/memory/mcp)
2. **[HOW]** Locate the target file:
   - skill: .claude/skills/<name>/SKILL.md
   - rule: .claude/rules/<name>.md
   - hook: .claude/hooks.json (or settings.json hooks section)
   - agent: .claude/agents/<name>.md
   - claude-md: CLAUDE.md
   - memory: auto memory path MEMORY.md
   - mcp: .mcp.json
   - If name not specified and multiple exist, list them and ask which one
3. **[HOW]** Read the current file content
4. **[HOW]** Call preferences with action="get" to load user preferences
5. **[HOW]** Call knowledge to fetch latest best practices for this file type:
   - query: "Claude Code <type> best practices latest spec"
6. **[WHAT]** Compare current file against best practices and identify gaps:
   - skill: missing constraint type tags? missing guardrails? vague description? missing argument-hint?
   - rule: missing paths? vague instructions? too long?
   - hook: timeout too high? matcher too broad? missing error messages?
   - agent: missing model? vague description? excessive tools?
   - claude-md: over 200 lines? missing sections? vague rules?
   - memory: over 200 lines? chronological instead of topical? sensitive data?
   - mcp: hardcoded API keys? missing env vars?
7. **[HOW]** Present the proposed changes as a diff to the user:
   - Show each change with WHY it improves the file
   - Ask for approval before applying
8. **[HOW]** Apply approved changes with Edit tool (preserve unchanged sections)
9. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the updated file in a separate context:
   - Prompt: "Read <file-path> and validate against Claude Code <type> spec. Compare with latest best practices via mcp__claude-alfred__knowledge. Check all quality criteria for this file type. Report PASS or list specific remaining issues."
   - If issues found: present to user and offer to fix

## Guardrails

- Do NOT overwrite the file without showing changes and getting approval first
- Do NOT change content the user intentionally customized (check preferences)
- Do NOT add boilerplate the user previously removed (check git history if available)
- Do NOT apply changes silently — always explain WHY each change improves the file
