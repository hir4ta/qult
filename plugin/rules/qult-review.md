# qult review

Independent review is the primary quality gate after hooks were removed. Treat it as required, not optional.

## When /qult:review is required

- Any change spanning **5 or more source files** (configurable via `review.required_changed_files`)
- Any commit while a plan is active (regardless of file count)
- Before merging to main / opening a PR

## How /qult:review works

`/qult:review` runs a 4-stage independent review:

1. **Spec compliance** (`spec-reviewer`) — implementation vs plan
2. **Code quality** (`quality-reviewer`) — design, maintainability, edge cases
3. **Security** (`security-reviewer`) — OWASP Top 10, hardening
4. **Adversarial** (`adversarial-reviewer`) — edge cases, logic errors, silent failures

The aggregate score must meet `review.score_threshold` (default 30/40). Each dimension must meet `review.dimension_floor` (default 4/5).

## Detector context

Stage 0.7 of `/qult:review` calls `mcp__plugin_qult_qult__get_detector_summary` which runs detectors on changed files on-demand. Reviewers receive these findings as context — they must NOT contradict detector results (security findings are ground truth).

## Do not self-review

The model that wrote the code must NOT also be the reviewer. `/qult:review` spawns independent subagents with separate context. The "AI Code Review Fails to Catch AI-Generated Vulnerabilities" research shows self-review misses 64.5% of self-introduced errors.

## After review passes

The reviewer skill calls `mcp__plugin_qult_qult__record_review` automatically. Verify via `mcp__plugin_qult_qult__get_session_status` that `review_completed_at` is set before committing.
