---
name: prepare
description: >
  Generate a new Claude Code configuration file (skill, rule, hook, agent,
  MCP server, CLAUDE.md, or memory) following latest best practices and
  the user's preferences.
user-invocable: true
argument-hint: "<type> [name]"
allowed-tools: Read, Write, Edit, Glob, Bash, Agent, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__preferences
context: current
---

The butler prepares what the master needs — tailored to their preferences.

## Steps

1. **[HOW]** Load user preferences:
   - Call `preferences` with action="get" to understand coding style and workflow

2. **[WHAT]** Determine target type:
   - Parse $ARGUMENTS for type: `skill`, `rule`, `hook`, `agent`, `mcp`, `claude-md`, `memory`
   - If type not provided or unclear, ask with AskUserQuestion
   - If name not provided, ask for it (except claude-md and memory which have fixed paths)

3. **[HOW]** Check for collisions:
   - Glob for existing files at the target path
   - If exists, warn and ask whether to overwrite or use `/polish` instead

4. **[HOW]** Gather requirements (type-specific):
   - **skill**: purpose, user-invocable flag, fork/current context, allowed-tools
   - **rule**: enforcement concept, glob patterns (e.g., `**/*.go`)
   - **hook**: event type, handler purpose, blocking behavior
   - **agent**: specialization, required tools, memory type (user/project/local)
   - **mcp**: server name/npm package, server type (stdio/sse)
   - **claude-md**: detect project stack (go.mod, package.json, etc.), scan structure
   - **memory**: check auto memory path, topic organization

5. **[HOW]** Search best practices:
   - Call `knowledge` with query about the specific type's best practices

6. **[Template]** Generate from type-specific template:
   - **skill**: frontmatter (name, description, allowed-tools, context, agent) + constraint tags (HOW/WHAT/Template/Guardrails)
   - **rule**: frontmatter with paths + actionable instructions (<20 lines)
   - **hook**: hooks.json entry (timeout, matcher, command) + handler script
   - **agent**: frontmatter (name, description, tools, model, maxTurns, memory) + system prompt
   - **mcp**: .mcp.json entry (command, args, env — no hardcoded API keys)
   - **claude-md**: Stack, Commands, Structure, Rules sections (<200 lines)
   - **memory**: MEMORY.md template organized by topic

7. **[HOW]** Validate (type-specific):
   - skill: name format, tool least-privilege, guardrails section exists
   - rule: glob patterns valid, instructions actionable (no "consider"), concise
   - hook: timeout ≤5s for PreToolUse, ≤30s for others, matcher not overly broad
   - agent: name lowercase-hyphens, model explicit, tools minimal
   - mcp: command executable, env vars for secrets
   - claude-md: <200 lines, copy-pasteable commands
   - memory: <200 lines, no session-specific content

8. **[HOW]** Write file to target path

9. **[HOW]** Independent review:
   - Spawn Explore agent to validate the generated file against knowledge base
   - Fix any issues found

## Target Paths

| Type | Path |
|------|------|
| skill | `.claude/skills/<name>/SKILL.md` |
| rule | `.claude/rules/<name>.md` |
| hook | `.claude/hooks.json` (or settings.json hooks section) |
| agent | `.claude/agents/<name>.md` |
| mcp | `.mcp.json` |
| claude-md | `CLAUDE.md` (project root) |
| memory | Auto memory path `MEMORY.md` |

## Guardrails

- Do NOT generate without checking user preferences first
- Do NOT use overly broad tool lists — apply least-privilege
- Do NOT skip the independent review step
- Do NOT hardcode API keys or secrets in any generated file
- Do NOT create files that exceed type-specific line limits
