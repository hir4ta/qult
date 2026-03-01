---
name: alfred-preferences
description: >
  View all preferences alfred remembers about you. Shows coding style,
  workflow, communication, and tool preferences.
user-invocable: true
allowed-tools: mcp__claude-alfred__preferences
---

View your recorded preferences.

## Steps

1. **[HOW]** Call preferences with action="get" (no category filter — get all)
2. **[Template]** Group by category and display in the format below

## Output

**Coding Style**
- [key]: [value] (source: explicit/inferred)

**Workflow**
- ...

If no preferences: "No preferences recorded yet. Use /alfred:learn to teach alfred."

## Guardrails

- Do NOT modify preferences in this skill — it's read-only
