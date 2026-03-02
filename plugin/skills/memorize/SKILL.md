---
name: memorize
description: >
  Tell alfred about your Claude Code preferences and working style, or view
  what alfred already remembers. Preferences persist across all projects
  and sessions.
user-invocable: true
argument-hint: "[preference to remember]"
allowed-tools: AskUserQuestion, mcp__alfred__preferences
context: current
---

The butler memorizes the master's preferences — every detail matters.

## Steps

1. **[WHAT]** Determine intent:
   - If $ARGUMENTS provided: treat as a preference to remember → go to Step 3
   - If no arguments: show current preferences first

2. **[HOW]** Show current preferences:
   - Call `preferences` with action="get" (no filters)
   - Group by category and display:
     ```
     ## Your Preferences

     ### Coding Style
     - language: Go
     - ...

     ### Workflow
     - ...
     ```
   - If empty: "No preferences recorded yet. Tell me what you'd like me to remember."

3. **[HOW]** Record new preference:
   - Parse the preference from $ARGUMENTS or ask with AskUserQuestion:
     - Category: coding_style, workflow, communication, tools
     - Key: descriptive, reusable identifier
     - Value: concrete, actionable preference
   - Call `preferences` with action="set", source="explicit"

4. **[Template]** Confirm:
   ```
   Remembered: [category] / [key] = [value]
   ```

## Guardrails

- Do NOT infer preferences without explicit user confirmation
- Do NOT store vague or ambiguous values — ask for clarification
- Do NOT overwrite existing preferences without showing the current value first
- Keep keys short and descriptive (e.g., "commit_style", "test_framework")
