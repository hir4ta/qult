---
name: alfred-explain
description: >
  Explain any Claude Code feature with concrete examples. Covers hooks,
  skills, rules, agents, MCP, memory, worktrees, teams, and more.
user-invocable: true
argument-hint: "[feature-name]"
allowed-tools: AskUserQuestion, mcp__claude-alfred__knowledge
---

Claude Code feature explainer.

## Steps

1. **[HOW]** If $ARGUMENTS is provided, use it as the feature name. Otherwise ask:
   "Which feature would you like to learn about?"
   - Hooks, Skills, Rules, Agents, MCP Servers, Memory, Other
2. **[HOW]** Call knowledge with query about the selected feature
3. **[Template]** Explain using this format:

## Output

**[Feature Name]**

**What**: <one sentence>
**When to use**: <2-3 concrete scenarios>
**Setup**:
```
<minimal working example, copy-pasteable>
```
**Tips**: <2-3 practical tips>

## Guardrails

- Do NOT write abstract descriptions — every explanation needs a concrete example
- Do NOT explain multiple features at once — focus on the one requested
