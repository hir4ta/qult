# /qult:wave-complete

Finalize the current Wave: verify, test, detector-gate, commit, persist range.

## Pre-flight

1. Call MCP `get_active_spec`. Refuse if `null`.
2. Read `tasks.md`. Every task in the current Wave must be `[x]`. Refuse with the
   list of pending / in_progress / blocked tasks if any remain.

## Stage 1 — Range integrity

For every prior `waves/wave-MM.md` (MM < current), read its `Range` field and verify
both SHAs via `git rev-parse --verify <sha>^{commit}`. If any are unreachable
(rebase / reset --soft / force-push happened), surface the stale list and ask
`re-record / abort`.

## Stage 2 — Test gate

Detect the project's test command from `package.json` / `Cargo.toml` / `pyproject.toml`.
Run it. On non-zero exit, stop. On success, call MCP `record_test_pass(command)`.

## Stage 3 — Detector gate

Call MCP `get_detector_summary`. If any finding has `severity ∈ {high, critical}`,
stop and surface them. The user must fix or call `clear_pending_fixes(reason)` before
continuing. Severity `medium` / `low` are warnings.

## Stage 4 — Commit message

Read `CLAUDE.md` (or `AGENTS.md`) and `git log -10 --format=%s`. Follow project conventions.
Prefix MUST be `[wave-NN]` (zero-padded). Show the message to the user and wait for
confirmation. Do not auto-commit.

## Stage 5 — Commit and finalize

After confirmation: `git add -A && git commit -m "<message>"`. Capture the new HEAD SHA.
Compute `Range: <start>..<end>` and call MCP `complete_wave(wave_num, commit_range)`.

## Don'ts

- Do not bypass the test gate with `--no-verify`.
- Do not silently call `clear_pending_fixes` without a reason.
- Do not squash WIP commits — Range integrity depends on the SHAs.
- Do not mutate prior Wave files' Range.
