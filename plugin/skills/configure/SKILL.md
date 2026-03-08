---
name: configure
description: >
  Create or polish a single Claude Code configuration file (skill, rule, hook,
  agent, MCP server, CLAUDE.md, or memory) with independent review.
  For project-wide setup, use /alfred:setup instead.
user-invocable: true
argument-hint: "<type> [name]"
context: current
allowed-tools: Read, Write, Edit, Glob, Agent, AskUserQuestion, mcp__plugin_alfred_alfred__knowledge
---

Alfred tends to the project's configuration — whether building new or polishing existing.

## Supporting Files

- **best-practices.md** — Claude Code configuration best practices for all types (CLAUDE.md, skills, rules, hooks, agents, MCP, memory). Read this file when generating or reviewing configuration.

## Steps

1. **[WHAT]** Determine target type from $ARGUMENTS:
   - Parse for type: `skill`, `rule`, `hook`, `agent`, `mcp`, `claude-md`, `memory`
   - If type not provided or unclear, ask with AskUserQuestion
   - If name not provided, ask for it (except claude-md and memory which have fixed paths)

2. **[HOW]** Check if target file exists:
   - Glob for existing files at the target path (see Target Paths below)

3. **[HOW]** If file EXISTS (polish flow):
   - Read the current file content in full
   - Call `knowledge` with query about latest best practices for this type
   - Compare against best practices and identify gaps (type-specific):
     - **skill**: tool least-privilege, argument-hint, context choice, guardrails section
     - **rule**: glob patterns valid, instructions actionable, concise (<20 lines)
     - **hook**: timeout values appropriate, matchers specific, handler robust
     - **agent**: model explicit, tools minimal, description explains WHEN to delegate, maxTurns set
     - **mcp**: env vars for secrets, valid command
     - **claude-md**: <200 lines, required sections, actionable rules, copy-pasteable commands
     - **memory**: <200 lines, topic-organized, no session-specific content
   - Present proposed changes with before/after diff and ask for approval
   - Use Edit tool to apply approved changes (preserve unchanged sections)

4. **[HOW]** If file is NEW (prepare flow):
   - Gather requirements (type-specific):
     - **skill**: purpose, user-invocable flag, fork/current context, allowed-tools
     - **rule**: enforcement concept, glob patterns (e.g., `**/*.go`)
     - **hook**: event type, handler purpose, blocking behavior
     - **agent**: specialization, required tools, memory type (user/project/local)
     - **mcp**: server name/npm package, server type (stdio/sse)
     - **claude-md**: detect project stack (go.mod, package.json, etc.), scan structure
     - **memory**: check auto memory path, topic organization
   - Call `knowledge` with query about the specific type's best practices
   - Generate from type-specific template:
     - **skill**: frontmatter (name, description, allowed-tools, context, agent) + guardrails section
     - **rule**: frontmatter with paths + actionable instructions (<20 lines)
     - **hook**: hooks.json entry (timeout, matcher, command) + handler script
     - **agent**: frontmatter (name, description, tools, model, maxTurns, memory) + system prompt
     - **mcp**: .mcp.json entry (command, args, env — no hardcoded API keys)
     - **claude-md**: Stack, Commands, Structure, Rules sections (<200 lines)
     - **memory**: MEMORY.md template organized by topic

5. **[HOW]** Validate type-specific constraints:
   - skill: name format, tool least-privilege, guardrails section exists
   - rule: glob patterns valid, instructions actionable (no "consider"), concise
   - hook: timeout ≤5s for PreToolUse, ≤30s for others, matcher not overly broad
   - agent: name lowercase-hyphens, model explicit, tools minimal
   - mcp: command executable, env vars for secrets
   - claude-md: <200 lines, copy-pasteable commands
   - memory: <200 lines, no session-specific content

6. **[HOW]** Write/Edit file to target path

7. **[HOW]** Independent review:
   - Spawn alfred agent to validate the generated/updated file against knowledge base
   - Fix any issues found

## Target Paths

| Type | Path |
|------|------|
| skill | `.claude/skills/<name>/SKILL.md` |
| rule | `.claude/rules/<name>.md` |
| hook | `.claude/hooks.json` |
| agent | `.claude/agents/<name>.md` |
| mcp | `.mcp.json` |
| claude-md | `CLAUDE.md` (project root) |
| memory | Auto memory path `MEMORY.md` |

## Guardrails

- Do NOT overwrite existing files without asking for approval first
- Do NOT use overly broad tool lists — apply least-privilege
- Do NOT skip the independent review step
- Do NOT hardcode API keys or secrets in any generated file
- Do NOT create files that exceed type-specific line limits
- Preserve the user's voice and style when updating existing files
