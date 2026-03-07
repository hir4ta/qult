---
paths:
  - "**/.claude/agents/**"
---

# Custom Agents Best Practices

Custom agents are specialized agent configurations for the Agent tool.

## Agent File Format (.md in .claude/agents/)
```markdown
---
name: my-agent
description: When to use this agent
allowed-tools: Read, Grep, Glob, Bash
---

Instructions for the agent go here.
```

## Key Fields
- `name` — identifier used in `subagent_type` parameter
- `description` — helps Claude decide when to spawn this agent
- `allowed-tools` — tools available to the agent (security boundary)

## Tips
- Restrict `allowed-tools` to minimum needed (principle of least privilege)
- Write clear instructions — agents don't have conversation history
- Include output format expectations in instructions
- Agents run in isolation — they can't see the main conversation
- Use for: code review, test running, research, parallel tasks
