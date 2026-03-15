---
name: quarters
description: >
  Project-wide Claude Code setup wizard, or explain any Claude Code feature
  with examples. Scans the whole project and guides multi-file configuration.
  Use when setting up a new project, wanting a full config audit with guided
  fixes, or needing a Claude Code feature explained. NOT for single-file
  creation (use /alfred:furnish). NOT for code review (use /alfred:inspect).
user-invocable: true
argument-hint: "[feature | --wizard]"
allowed-tools: Read, Write, Edit, Glob, AskUserQuestion, mcp__plugin_alfred_alfred__knowledge, mcp__plugin_alfred_alfred__config-review
context: fork
---

Alfred welcomes you and sets up the project for Claude Code.

## Supporting Files

- **../configure/best-practices.md** — Claude Code configuration best practices. Read when generating configuration files.

## Steps

1. **[WHAT]** Determine mode from $ARGUMENTS:
   - If arguments contain a feature name (hooks, skills, rules, agents, MCP, memory, worktrees, teams) → go to Step 2 (brief flow)
   - If arguments contain "--wizard" or no arguments → go to Step 3 (wizard flow)

2. **[HOW]** Brief flow — explain a feature:
   - Call `knowledge` with query about the selected feature
   - If multiple results, synthesize the most relevant
   - Output in template format:
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
   - STOP here

3. **[HOW]** Wizard flow — interactive setup:
   - Call `config-review` with project_path=$CWD to assess current setup
   - Present current state as a status checklist: `[x] CLAUDE.md`, `[ ] Hooks`, etc.

4. **[WHAT]** Ask what to configure:
   - Use AskUserQuestion with multiSelect=true:
     - CLAUDE.md
     - Skills
     - Rules
     - Hooks
     - MCP servers
     - Memory
   - Pre-select items that are missing

5. **[HOW]** Auto-detect project stack:
   - go.mod → Go project defaults (go vet, go test, Go rules)
   - package.json → Node project defaults (npm test, ESLint rules)
   - Cargo.toml → Rust project defaults
   - pyproject.toml → Python project defaults
   - Fall back to generic defaults

6. **[HOW]** Generate selected items:
   - For each selected item, follow generation logic with sensible defaults based on detected stack
   - Use streamlined wizard mode — ask fewer questions, prefer smart defaults

7. **[HOW]** Verify setup:
   - Call `config-review` again to check improvement
   - Report before/after score

8. **[Template]** Final output:
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

## Troubleshooting

- **config-review fails or times out**: Proceed without it; manually check for existing files with Glob.
- **Stack not detected**: Ask the user what language/framework they use.
- **Knowledge returns no results**: Use the best-practices.md reference file as fallback.
- **Generated config conflicts with existing**: Always read existing files first; merge, don't overwrite.

## Example

User: `/alfred:quarters`

```
Current setup: [x] CLAUDE.md  [ ] Skills  [x] Rules  [ ] Hooks  [ ] MCP

Detected: Go project (go.mod found)

What would you like to configure?
> [x] Hooks  [x] Skills  [ ] MCP

Created:
- .claude/hooks.json (3 hooks: SessionStart, PreToolUse, PostToolUse)
- .claude/skills/deploy/SKILL.md (deployment workflow)

Setup Score: 7/10 (was 4/10)
```

## Guardrails

- Do NOT overwrite existing files without asking
- Do NOT create configurations that conflict with each other
- Do NOT ask more than 2 questions per item in wizard mode (wizard should be fast)
- Do NOT skip stack detection — it drives sensible defaults
- Do NOT create items the user didn't select
- Do NOT output more than 20 lines in brief mode unless the user asks for detail
- Do NOT fabricate features in brief mode — only explain what's in the knowledge base
