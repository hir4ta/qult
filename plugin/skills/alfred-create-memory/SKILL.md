---
name: alfred-create-memory
description: >
  Set up project memory directory and MEMORY.md template for persistent
  context across conversations.
user-invocable: true
allowed-tools: Read, Write, Glob, Agent, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Set up project memory.

## Steps

1. **[HOW]** Check if .claude/memory/ or MEMORY.md already exists
2. **[HOW]** Call preferences with action="get" for user preferences
3. **[Template]** Create MEMORY.md at the auto memory path using the template below
4. **[WHAT]** Validate:
   - Under 200 lines (first 200 lines auto-loaded per session)
   - Organized by topic, not chronologically
   - No session-specific or temporary context
   - No sensitive data (credentials, API keys)
5. **[HOW]** Optionally create topic files in .claude/memory/ for detailed notes
6. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read the generated MEMORY.md and validate. Check: (1) under 200 lines, (2) organized by topic not chronologically, (3) no session-specific context, (4) no sensitive data, (5) call mcp__claude-alfred__knowledge with query='Claude Code memory best practices auto memory' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

```markdown
# Project Memory

## Architecture Decisions

- <key decision 1>

## Patterns & Conventions

- <confirmed pattern 1>

## Workflow Preferences

- <preference 1>

## Known Issues

- <recurring issue and its solution>
```

## Guardrails

- Do NOT store session-specific context (current task, in-progress work)
- Do NOT store unverified conclusions
- Do NOT store sensitive data (credentials, API keys)
- Do NOT exceed 200 lines
