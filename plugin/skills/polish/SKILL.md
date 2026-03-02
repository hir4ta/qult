---
name: polish
description: >
  Update an existing Claude Code configuration file (skill, rule, hook,
  agent, CLAUDE.md, memory, MCP) against latest best practices. Reads the
  current file, compares with knowledge base, proposes improvements.
user-invocable: true
argument-hint: "<type> [name]"
allowed-tools: Read, Write, Edit, Glob, Agent, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__preferences
context: current
---

The butler polishes what already exists — making it shine against current standards.

## Steps

1. **[WHAT]** Determine target:
   - Parse $ARGUMENTS for type and name: `skill foo`, `rule go-errors`, `claude-md`, etc.
   - If not provided, ask with AskUserQuestion
   - Locate file using target paths (same as `/prepare`)

2. **[HOW]** Read current file:
   - Read the target file content in full
   - If file not found, suggest using `/prepare` instead

3. **[HOW]** Load context:
   - Call `preferences` with action="get"
   - Call `knowledge` with query about latest best practices for this type

4. **[WHAT]** Compare and identify gaps (type-specific):
   - **skill**: constraint tags present (HOW/WHAT/Template/Guardrails), tool least-privilege, argument-hint, context choice
   - **rule**: glob patterns valid, instructions actionable, concise (<20 lines)
   - **hook**: timeout values appropriate, matchers specific, handler robust
   - **agent**: model explicit, tools minimal, description explains WHEN to delegate, maxTurns set
   - **mcp**: env vars for secrets, valid command
   - **claude-md**: <200 lines, required sections, actionable rules, copy-pasteable commands
   - **memory**: <200 lines, topic-organized, no session-specific content

5. **[Template]** Present proposed changes:
   ```
   ## Proposed Changes

   ### 1. [What changed] — Why
   - Before: ...
   - After: ...

   ### 2. ...

   Apply these changes? (y/n)
   ```

6. **[HOW]** Apply changes:
   - Use Edit tool to apply approved changes (preserve unchanged sections)
   - Do NOT rewrite the entire file

7. **[HOW]** Independent review:
   - Spawn Explore agent to validate the updated file
   - Fix any issues found

## Guardrails

- Do NOT rewrite sections the user didn't ask to change
- Do NOT apply changes without showing the diff and getting approval
- Do NOT remove user customizations that don't conflict with best practices
- Do NOT suggest changes that conflict with user preferences
- Preserve the user's voice and style in the file
