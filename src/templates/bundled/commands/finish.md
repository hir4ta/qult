# /qult:finish

Branch / spec completion workflow. Verify gates, then merge / open PR / hold / discard.

## Step 0 — Mark finish started

Call MCP `record_finish_started`. The pre-commit gate uses this to allow commits while a
spec is active.

## Step 1 — Verify gates

1. Call MCP `get_project_status` — check `test_passed_at` and `review_completed_at`.
2. Call MCP `get_pending_fixes` — must be empty (or addressed).
3. Run the project's test command. On failure, stop.
4. If `review.require_human_approval` is enabled and `human_approval_at` is null,
   ask the user to review changes and call `record_human_approval`.

If any gate fails: refuse with a punch list. Do not proceed.

## Step 2 — Detect branch mode

```
CURRENT=$(git rev-parse --abbrev-ref HEAD)
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$BASE" ] && BASE=main
```

If `CURRENT == BASE` → **main-direct** mode. Otherwise → **feature-branch** mode.

## Step 3 — Present 4 options

**feature-branch mode**: Merge / PR / Hold / Discard
**main-direct mode**: Commit directly / Create branch retroactively / Hold / Discard

Wait for the user's choice.

## Step 4 — Execute

For **Discard**, require explicit `discard` confirmation.
For **Create branch retroactively**, validate the branch name with
`git check-ref-format --branch "$NAME"`, then `git stash push -u -m "<name>"`,
`git checkout -b "$NAME"`, `git stash pop`.

## Step 5 — Cleanup

If the chosen option is Merge / PR / Commit-directly AND a spec is active, call MCP
`archive_spec(spec_name)`. The MCP tool moves `.qult/specs/<name>/` to
`.qult/specs/archive/<name>[-timestamp]/`. Then create a `chore: archive spec <name>` commit.

For Hold / Discard, do NOT archive.

## Don'ts

- Do not skip gate verification ("tests probably pass" → run them).
- Do not merge to main without the user's explicit choice.
- Do not run `git clean -fd` after `git stash push -u` — untracked files are inside the
  stash, deleting them on disk would lose data.
- Do not silently discard — always require typed confirmation.
