---
name: alfred-learn
description: >
  Tell alfred about your Claude Code preferences and working style.
  Records preferences that persist across all projects and sessions.
user-invocable: true
allowed-tools: AskUserQuestion, mcp__claude-alfred__preferences
---

Record your preferences.

## Steps

1. **[HOW]** Call preferences with action="get" to show current preferences
2. **[HOW]** Ask the user with AskUserQuestion:

   "What would you like alfred to remember?"
   - "Coding style preference" (e.g., commit language, testing approach)
   - "Workflow preference" (e.g., always use plan mode, prefer TDD)
   - "Tool preference" (e.g., preferred test runner, linter)
   - Other (free text)

3. **[HOW]** Based on selection, ask for the specific preference value
4. **[WHAT]** Validate:
   - Category is one of: coding_style, workflow, communication, tools
   - Key is specific and reusable (e.g. "commit_language" not "my preference")
   - Value is concrete (e.g. "japanese" not "I prefer japanese sometimes")
5. **[HOW]** Call preferences with action="set", appropriate category/key/value, source="explicit"

## Output

Confirm: Category / Key = Value. "This will be applied in future create operations."

## Guardrails

- Do NOT infer preferences without explicit user confirmation
- Do NOT store vague or ambiguous values
