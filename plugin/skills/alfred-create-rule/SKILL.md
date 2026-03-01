---
name: alfred-create-rule
description: >
  Generate a new Claude Code rule file following latest best practices
  and the user's preferences.
user-invocable: true
argument-hint: "[rule-name]"
allowed-tools: Read, Write, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create a new Claude Code rule.

## Steps

1. **[HOW]** Call preferences with action="get" to load user preferences
2. **[HOW]** Ask the user:
   - "What convention should this rule enforce?" (free text)
   - "Which files should it apply to?" (glob pattern, e.g. "**/*.go")
3. **[HOW]** Check existing rules with Glob pattern=".claude/rules/*.md"
4. **[Template]** Generate the rule using the template below
5. **[WHAT]** Validate:
   - paths field: valid glob patterns, specific enough to avoid over-matching
   - Instructions: actionable ("use X" not "consider using X")
   - Concise: rules inject into context on every match — keep short
6. **[HOW]** Write to .claude/rules/<name>.md
7. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read .claude/rules/<name>.md and validate against Claude Code rule spec. Check: (1) paths field has valid glob patterns, (2) instructions are actionable (no 'consider'/'try to'), (3) not duplicating CLAUDE.md content, (4) concise (under 20 lines), (5) call mcp__claude-alfred__knowledge with query='Claude Code rule best practices' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

```yaml
---
paths:
  - "**/*.ext"
---

# <Rule Name>

- <actionable instruction 1>
- <actionable instruction 2>
```

## Guardrails

- Do NOT create rules without paths (unless user explicitly wants a global rule)
- Do NOT duplicate CLAUDE.md content in rules
- Do NOT write vague instructions ("consider" → "use", "try to" → "always")
