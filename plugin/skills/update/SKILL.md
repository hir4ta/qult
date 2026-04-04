---
name: update
description: Update qult rules files in the current project after a plugin update. Overwrites existing rules with the latest version. Use after running /plugin update to sync project-level rules with the latest qult version. NOT for initial setup (use /qult:init instead).
user_invocable: true
---

# /qult:update

Update qult rules files after a plugin update. Overwrites existing rules with the latest version.

Plugin update (`/plugin` > update) automatically updates hooks, skills, agents, and MCP server.
This skill updates the **project-level rules files** that were copied during `/qult:init`.

## Steps

1. **Overwrite rules files** in `Project/.claude/rules/`:

### qult-gates.md
```markdown
# qult Quality Gates

> Quality by Structure, Not by Promise. The Wall doesn't negotiate.

IMPORTANT: These rules are enforced by qult hooks. Follow them exactly.

## MCP Tool Usage

- When a tool is DENIED by qult, you MUST call `mcp__plugin_qult_qult__get_pending_fixes()` immediately
- Before committing, ALWAYS call `mcp__plugin_qult_qult__get_session_status()` to check for blockers
- After a TaskCompleted hook runs, call `mcp__plugin_qult_qult__get_session_status()` to see verification results
- If gates are not configured, run `/qult:detect-gates`

## Commit Gates — Proof or Block

- NEVER commit with unresolved lint/typecheck errors
- Tests MUST pass before committing (when on_commit gates are configured)
- Independent 3-stage review (`/qult:review`) is required for large changes or when a plan is active
  - Stage 1: Spec compliance (Completeness + Accuracy)
  - Stage 2: Code quality (Design + Maintainability)
  - Stage 3: Security (Vulnerability + Hardening)

## Workflow

- The architect decides what to build. The agent decides how to build it.
- When requirements are unclear, use `/qult:explore` to interview the architect.
- When debugging, use `/qult:debug` for structured root-cause analysis.
- When finishing a branch, use `/qult:finish` for structured completion.
```

### qult-quality.md
```markdown
# Quality Rules (qult)

> Proof or Block. No completion claims without fresh verification evidence.

## Test-Driven

- ALWAYS write the test file FIRST, then implement
- At least 2 meaningful assertions per test case
- NEVER mark implementation as complete until tests pass

## Task Scope

- Quick fix (no plan): keep changes focused, 1-2 files per logical change
- Planned work: follow the plan's task boundaries, scope is set by the plan

## Ambiguity Resolution

- When requirements are unclear, ask the architect — never guess
- When debugging, investigate root cause first — never guess-fix
```

### qult-plan.md
```markdown
# Plan Rules (qult)

> The architect decides what to build. The plan describes how.

## Plan Structure

IMPORTANT: When writing a plan, you MUST use this structure:

\```
## Context
Why this change is needed.

## Tasks
### Task N: <name> [pending]
- **File**: <path>
- **Change**: <what to do>
- **Boundary**: <what NOT to change>
- **Verify**: <test file : test function>

## Success Criteria
- [ ] `<specific command>` -- expected outcome
\```

Update task status to [done] as you complete each task.

## Task Registration

When transitioning from Plan mode to implementation:
1. Read the approved plan file
2. Create a task (TaskCreate) for each Task entry
3. Update each task status as you work
```

2. **Remove legacy rule file** if it exists: `Project/.claude/rules/qult.md` (renamed to `qult-gates.md`)

3. **Re-detect gates** if `.qult/gates.json` is missing: run `/qult:detect-gates`

4. **Clean up legacy hook registration**: If `.claude/settings.local.json` exists, remove any qult hook entries (commands containing `.qult/hook.mjs`) from the `hooks` object. Remove `.qult/hook.mjs` if it exists. These are no longer needed — hooks are now provided by the plugin.

5. **Update settings hooks if registered**: If `.claude/settings.local.json` has qult hook entries (commands containing `${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs`), update them to match the current plugin hooks.json content. This covers users who ran `/qult:register-hooks`.

## Output

Confirm: `qult updated: rules (qult-gates.md, qult-quality.md, qult-plan.md)`
