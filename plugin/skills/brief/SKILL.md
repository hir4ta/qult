---
name: brief
description: >
  Explain any Claude Code feature with concrete examples. Covers hooks,
  skills, rules, agents, MCP, memory, worktrees, teams, and more.
user-invocable: true
argument-hint: "<feature>"
allowed-tools: AskUserQuestion, mcp__alfred__knowledge
context: current
---

The butler's morning briefing — concise, clear, actionable.

## Steps

1. **[WHAT]** Determine feature to explain:
   - If $ARGUMENTS provided, use as feature name
   - Otherwise, ask with AskUserQuestion: "Which feature would you like explained?"
     - Options: hooks, skills, rules, agents, MCP, memory, worktrees, teams

2. **[HOW]** Search knowledge base:
   - Call `knowledge` with query about the selected feature
   - If multiple results, synthesize the most relevant

3. **[Template]** Output format:
   ```
   ## <Feature Name>

   **What**: One sentence explanation.

   **When to use**:
   - Scenario 1
   - Scenario 2

   **Setup** (copy-pasteable):
   ```
   <minimal working example>
   ```

   **Tips**:
   - Practical tip 1
   - Practical tip 2
   ```

## Guardrails

- Do NOT output more than 20 lines unless the user asks for detail
- Do NOT fabricate features — only explain what's in the knowledge base
- Do NOT include boilerplate or generic advice — be specific and practical
- Do NOT explain multiple features at once — focus on the one requested
