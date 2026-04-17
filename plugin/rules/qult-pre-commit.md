# qult pre-commit checklist

Before running `git commit` in a qult-enabled project, verify the following.

## Required checks

1. **Find and run the test command** — read `package.json` (scripts.test) or `Cargo.toml` / `pyproject.toml` / `Gemfile` to identify the project's test command. Run it via Bash and confirm exit 0. Then call `mcp__plugin_qult_qult__record_test_pass` with the exact command string.
2. **Check session status** — call `mcp__plugin_qult_qult__get_session_status`. Verify:
   - `pending_fixes` is empty (or addressed)
   - `test_passed_at` is recent
   - `review_completed_at` is set if the change is non-trivial
3. **Review** — if 5 or more source files changed, OR a plan is active, run `/qult:review` first. After review passes, the MCP server records the score automatically; verify via `get_session_status`.
4. **Finish** — if a plan is active, run `/qult:finish` instead of committing directly. `/qult:finish` runs the structured completion checklist (merge/PR/hold/discard).

## Source change detection

Only the steps above apply when source code changed (e.g. `.ts`, `.py`, `.go`, `.rs`). For non-source commits (version bump, README, lockfile-only), skip the test/review steps — but still confirm `get_session_status` shows no blocking `pending_fixes`.

## Honest reporting

If a check fails, fix the underlying issue. Do NOT bypass with `--no-verify`, `commit.gpgsign=false`, or by ignoring `pending_fixes`. The architect must approve any skip.
