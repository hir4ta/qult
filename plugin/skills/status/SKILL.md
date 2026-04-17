---
name: status
description: "Show the current qult session state: pending fixes, test pass, review completion, and changed files. Use to check commit readiness. NOT for diagnosing setup issues (use /qult:doctor)."
user-invocable: true
---

# /qult:status

Report the current qult session state.

## Steps

1. Call `mcp__plugin_qult_qult__get_pending_fixes()` for detector findings awaiting resolution
2. Call `mcp__plugin_qult_qult__get_session_status()` for test pass / review completion / changed files

## Output format

Concise summary:

```
Pending fixes: 2 (security-check: src/auth.ts, test-quality: src/__tests__/foo.test.ts)
Tests: not passed
Review: not completed
Changed files: 5
```

If clear:

```
All clear. No pending fixes, tests passed, review completed.
```

## What this skill does NOT show

- **Configured tool commands** (lint/test/typecheck) — qult does not cache project toolchain. Read `package.json` / `Cargo.toml` / `pyproject.toml` directly if you need the commands.
- **Plugin version / rules sync state** — use `/qult:doctor` for that.
