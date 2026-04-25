# qult pre-commit checklist

Before running `git commit` in a qult-enabled project, verify the following.

## Required checks

1. **Find and run the project test command** — read `package.json` (`scripts.test`), `Cargo.toml`, `pyproject.toml`, etc. Run via Bash, confirm exit 0. Then call `mcp__plugin_qult_qult__record_test_pass({ command })` with the exact command string.
2. **Check project status** — call `mcp__plugin_qult_qult__get_project_status`. Verify:
   - `pending_fixes` is empty (or every entry is `severity: low|medium`).
   - `test_passed_at` is recent.
   - If a spec is active and this is the **last commit of a Wave**, the upcoming `/qult:wave-complete` will run review of `pending_fixes` and block on `severity ∈ {high, critical}`.
3. **Wave-prefix discipline** — if a spec is active:
   - Every commit message MUST start with `[wave-NN]` where NN is 2-digit zero-padded.
   - Use `/qult:wip` to compose intermediate WIP commits (auto-prefixes).
   - The closing commit per Wave is created by `/qult:wave-complete`, not by direct `git commit`.
4. **Review** — if the change is at **spec completion** (final Wave done), run `/qult:review`. Aggregate score must meet `review.score_threshold` (default 30). Each dimension must meet `review.dimension_floor` (default 4).
5. **Finish via `/qult:finish`** — when `record_review` is set and all Waves are done, prefer `/qult:finish` over a direct commit. It runs the structured merge/PR/hold/discard checklist and archives the spec.

## Source-change detection

Steps 1, 2, 4, 5 apply when source code changed (e.g. `.ts`, `.py`, `.go`, `.rs`). For non-source commits (version bumps, README, lockfile-only), the test step may be skipped — but `get_project_status` MUST still show no blocking `pending_fixes`.

## Honest reporting

If a check fails, fix the underlying issue. Do **not** bypass with `--no-verify`, `commit.gpgsign=false` (host-wide), or by ignoring `pending_fixes`. The architect must approve any skip via `/qult:skip`.
