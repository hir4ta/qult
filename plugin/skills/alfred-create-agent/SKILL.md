---
name: alfred-create-agent
description: >
  Generate a custom Claude Code agent definition following latest best
  practices and the user's preferences.
user-invocable: true
argument-hint: "[agent-name]"
allowed-tools: Read, Write, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create a new custom agent.

## Steps

1. **[HOW]** Call preferences with action="get" for user preferences
2. **[HOW]** Ask the user:
   - "What should this agent specialize in?" (free text)
   - "Which tools should it have access to?" (suggest based on purpose)
   - "Should it have persistent memory?" (user/project/local)
3. **[HOW]** Check existing agents with Glob pattern=".claude/agents/*.md"
4. **[Template]** Generate agent markdown using the template below
5. **[WHAT]** Validate:
   - name: required, lowercase letters and hyphens
   - description: required, describes WHEN to delegate (not just what it does)
   - tools: minimal set needed (principle of least privilege)
   - model: explicit (sonnet for most, haiku for fast read-only, opus for complex)
6. **[HOW]** Write to .claude/agents/<name>.md
7. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read .claude/agents/<name>.md and validate against Claude Code agent spec. Check: (1) frontmatter has name+description+tools+model, (2) description explains WHEN to delegate (not just what it does), (3) tools follow least privilege, (4) model is explicit, (5) call mcp__claude-alfred__knowledge with query='Claude Code custom agent definition best practices' to verify. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

```yaml
---
name: <agent-name>
description: >
  <When Claude should delegate to this agent. Be specific about triggers.>
tools: <comma-separated list>
model: sonnet
maxTurns: 30
# memory: user   # uncomment for persistent cross-session memory
---

<Agent instructions. Be direct about role and output format.>

## Decision Flow

1. <first action>
2. <second action>

## Output Format

- <expected output structure>
```

## Guardrails

- Do NOT give agents Write/Edit tools unless they need to modify files
- Do NOT omit model field (implicit inherit may pick wrong model)
- Do NOT write vague descriptions — agents need clear delegation triggers
