---
name: greetings
description: >
  Interactive wizard to set up Claude Code best practices for your project.
  Creates CLAUDE.md, hooks, skills, rules, and MCP configuration step by step.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__preferences, mcp__alfred__review
context: current
---

Welcome to the estate — the butler prepares everything for a new master.

## Steps

1. **[HOW]** Assess current setup:
   - Call `review` with project_path=$CWD to see what already exists
   - Call `preferences` with action="get" to load user style

2. **[WHAT]** Show setup status and ask what to configure:
   - Present current state: `[x] CLAUDE.md`, `[ ] Hooks`, etc.
   - Use AskUserQuestion with multiSelect=true:
     - CLAUDE.md
     - Skills
     - Rules
     - Hooks
     - MCP servers
     - Memory
   - Pre-select items that are missing

3. **[HOW]** For each selected item, run the creation flow:
   - Follow the same generation logic as `/prepare` for each type
   - But streamlined — use sensible defaults based on detected project stack
   - Ask fewer questions than standalone `/prepare` (wizard mode)

4. **[HOW]** Detect project stack automatically:
   - go.mod → Go project defaults (go vet, go test, Go rules)
   - package.json → Node project defaults (npm test, ESLint rules)
   - Cargo.toml → Rust project defaults
   - pyproject.toml → Python project defaults
   - Fall back to generic defaults

5. **[HOW]** Verify setup:
   - Call `review` again to check improvement
   - Report before/after score

6. **[Template]** Final output:
   ```
   ## Setup Complete

   Created:
   - CLAUDE.md (N lines)
   - .claude/hooks.json (N hooks)
   - ...

   Setup Score: N/10 (was M/10)

   Next: Try asking Claude Code about your project — alfred's knowledge
   base will help provide better answers.
   ```

## Guardrails

- Do NOT overwrite existing files without asking
- Do NOT create configurations that conflict with each other
- Do NOT ask more than 2 questions per item (wizard should be fast)
- Do NOT skip stack detection — it drives sensible defaults
- Do NOT create items the user didn't select
