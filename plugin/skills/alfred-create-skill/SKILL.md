---
name: alfred-create-skill
description: >
  Generate a new Claude Code skill file following latest best practices
  and the user's preferences.
user-invocable: true
argument-hint: "[skill-name]"
allowed-tools: Read, Write, Glob, Agent, AskUserQuestion, mcp__claude-alfred__knowledge, mcp__claude-alfred__preferences
---

Create a new Claude Code skill.

## Steps

1. **[HOW]** Call preferences with action="get" to load user's coding style and workflow preferences
2. **[HOW]** Ask the user with AskUserQuestion:
   - "What should this skill do?" (free text)
   - "Should it be user-invocable?" (yes/no)
   - "Should it run in a forked context?" (yes for heavy exploration, no for quick tasks)
3. **[HOW]** Check existing skills with Glob pattern=".claude/skills/*/SKILL.md" to avoid name collisions
4. **[Template]** Generate SKILL.md using the template below, filling in user's requirements
5. **[WHAT]** Validate the generated skill against these criteria:
   - name field: lowercase, hyphens only, max 64 chars
   - description field: present and specific (not vague like "does stuff")
   - Each step tagged with constraint type (HOW/WHAT/Template/Guardrails)
   - allowed-tools: only tools actually needed (principle of least privilege)
   - If context=fork, agent field must be set
6. **[HOW]** Apply user preferences (language, style) to the generated content
7. **[HOW]** Write the file to .claude/skills/<name>/SKILL.md
8. **[WHAT] Independent Review** Spawn an Agent (subagent_type: "Explore") to review the generated file in a separate context:
   - Prompt: "Read .claude/skills/<name>/SKILL.md and validate against Claude Code skill spec. Check: (1) frontmatter has required name+description, (2) all steps have constraint type tags [HOW/WHAT/Template/Guardrails], (3) allowed-tools follows least privilege, (4) guardrails section exists with concrete prohibitions, (5) call mcp__claude-alfred__knowledge with query='Claude Code skill best practices' to verify against latest docs. Report PASS or list specific issues."
   - If issues found: fix them and note what was corrected

## Template

```yaml
---
name: <skill-name>
description: >
  <one-line description of when Claude should use this skill>
user-invocable: true
argument-hint: "[optional-args]"
allowed-tools: <comma-separated list>
# context: fork          # uncomment for heavy exploration
# agent: general-purpose # required when context=fork
---

<Brief description of what the skill does.>

## Steps

1. **[HOW/WHAT/Template/Guardrails]** <step description>
2. ...

## Output

<Expected output format>

## Guardrails

- <things the skill must NOT do>
```

## Guardrails

- Do NOT create skills with vague descriptions
- Do NOT allow tools the skill doesn't actually need
- Do NOT omit constraint type tags on steps
