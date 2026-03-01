---
name: alfred-create-claude-md
description: >
  Create or improve a project's CLAUDE.md from project structure analysis,
  best practices, and the user's preferences.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Bash, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create or improve CLAUDE.md.

## Steps

1. **[HOW]** Call preferences with action="get" for user preferences (language, style)
2. **[HOW]** Detect project stack:
   - Glob for go.mod, package.json, Cargo.toml, pyproject.toml, etc.
   - Read the detected config file to identify stack and dependencies
3. **[HOW]** Scan project structure with Glob and Bash (directory listing)
4. **[HOW]** Read existing CLAUDE.md if present
5. **[Template]** Generate or improve CLAUDE.md using the template below
6. **[WHAT]** Validate:
   - Under 200 lines (every line costs context window)
   - Has ## Stack, ## Commands, ## Structure, ## Rules sections
   - Commands are copy-pasteable (not relative or ambiguous)
   - Rules are actionable ("use X" not "consider using X")
   - No duplicate content from README
   - No environment-specific paths
7. **[HOW]** Write CLAUDE.md
8. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read CLAUDE.md and validate against Claude Code best practices. Check: (1) under 200 lines, (2) has Stack/Commands/Structure/Rules sections, (3) commands are copy-pasteable, (4) rules are actionable (no 'consider'/'try to'), (5) no README duplication, (6) call mcp__claude-alfred__knowledge with query='CLAUDE.md best practices structure' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

```markdown
# <project-name>

<one-line description>

## Stack

<language> / <framework> / <key deps>

## Commands

```bash
<build command>
<test command>
<lint command>
```

## Structure

| Package | Role |
|---------|------|
| <dir>   | <purpose> |

## Rules

- <actionable rule 1>
- <actionable rule 2>
```

## Guardrails

- Do NOT exceed 200 lines
- Do NOT duplicate README content
- Do NOT include environment-specific paths
- Do NOT write vague rules
