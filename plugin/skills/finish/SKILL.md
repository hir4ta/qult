---
name: finish
description: "Branch completion workflow. Use when implementation is complete and all tests pass — guides the architect through merge, PR, hold, or discard options. NOT for incomplete work or failing tests."
user-invocable: true
---

# /qult:finish

Structured branch completion. Present options, execute the architect's choice.

> **Proof or Block.** No completion claims without fresh verification evidence.

## Process

### Step 0: Record Finish Started

**First**, call `mcp__plugin_qult_qult__record_finish_started()` to mark the finish flow as active. This is used by pre-commit rule guidance.

### Step 1: Verify All Gates

Run verification before anything else:

1. Call `mcp__plugin_qult_qult__get_session_status()` — check test and review status
2. Call `mcp__plugin_qult_qult__get_pending_fixes()` — check for unresolved issues
3. Run the project's test command via Bash
4. If `review.require_human_approval` is enabled in config (stored in DB, accessible via MCP tools), check `human_review_approved_at` in session status. If null, add `Human approval: not recorded` to the BLOCKED list and instruct the architect to review the changes, then call `mcp__plugin_qult_qult__record_human_approval()` to record their approval

**If any gate is NOT clear:**
```
BLOCKED: Cannot finish.
- [ ] Pending fixes: N remaining
- [ ] Tests: not passed
- [ ] Review: not completed

Fix these first, then run /qult:finish again.
```

Stop. Do NOT proceed to Step 2.

### Step 2: Determine Base Branch

1. Check current branch name: `CURRENT=$(git rev-parse --abbrev-ref HEAD)`
2. Determine base branch with a fallback chain (remote HEAD → local main/master → last-resort "main"):
   ```bash
   CURRENT=$(git rev-parse --abbrev-ref HEAD)
   BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
   if [ -z "$BASE" ]; then
     for cand in main master; do
       if git rev-parse --verify "$cand" >/dev/null 2>&1; then BASE="$cand"; break; fi
     done
   fi
   [ -z "$BASE" ] && BASE="main"
   ```
3. Detect whether the architect is working **directly on the base branch** (common in solo/personal-dev workflow) or on a **feature branch**:
   - If `$CURRENT` == `$BASE` → **main-direct** mode
   - Otherwise → **feature-branch** mode
4. Show the architect the summary:

**feature-branch mode**:
```
Branch: feature/xyz
Base: main
Commits: N (ahead of base)
Changed files: N
Tests: PASSED
Review: PASSED (Score: N/30)
```

**main-direct mode**:
```
On base branch: main (direct-to-main workflow)
Uncommitted files: N
Staged commits: N (not yet pushed)
Tests: PASSED
Review: PASSED (Score: N/30)
```

### Step 3: Present Options

Present exactly 4 options appropriate to the current mode (no more, no fewer, no open-ended questions). Use AskUserQuestion with these exact options. Wait for the architect's choice.

**feature-branch mode** — 4 options:
```
How would you like to finish this branch?

1. **Merge** — Merge into [base] and delete the branch
2. **PR** — Push and create a pull request for team review
3. **Hold** — Keep the branch as-is for later
4. **Discard** — Delete the branch and all changes
```

**main-direct mode** — 4 options:
```
How would you like to finish this work? (On base branch [base])

1. **Commit directly** — Commit uncommitted changes to [base] (pre-commit gates must pass)
2. **Create branch retroactively** — Move current uncommitted changes to a new branch and create a PR
3. **Hold** — Keep uncommitted changes as-is for later
4. **Discard** — Revert uncommitted changes (git restore)
```

### Step 4: Execute Choice

#### feature-branch mode

##### Option 1: Merge
1. `git checkout [base]`
2. `git merge [branch] --no-ff`
3. `git branch -d [branch]`
4. Report: "Merged [branch] into [base]. Branch deleted."

##### Option 2: PR
1. `git push -u origin [branch]`
2. Create PR via `gh pr create`:
   - Title: concise summary of the change
   - Body: summary of changes, test plan
3. Report: "PR created: [URL]"

##### Option 3: Hold
1. Optionally push: ask the architect "Push to remote for backup?"
2. Report: "Branch [branch] is on hold. Resume anytime."

##### Option 4: Discard
1. **Require explicit confirmation** via AskUserQuestion:
   "Type 'discard' to confirm deleting branch [branch] and all its changes. This cannot be undone."
2. Only on exact confirmation:
   - `git checkout [base]`
   - `git branch -D [branch]`
3. Report: "Branch [branch] discarded."

#### main-direct mode

##### Option 1: Commit directly
1. If uncommitted changes exist, stage selectively (`git add <files>` — avoid `git add -A` to prevent committing sensitive files)
2. Ask the architect for a commit message
3. `git commit -m "<message>"`
4. Optionally push: ask "Push to origin now?"
5. Report: "Committed to [base]. Pushed." (or "Not pushed.")

##### Option 2: Create branch retroactively
1. Ask the architect for a branch name (e.g. `feature/xyz`).
2. **Validate the branch name**: `git check-ref-format --branch "$NAME"`. If it exits non-zero, or the architect supplies names like `HEAD` / `-foo` that would fail later, reject and re-prompt — **bounded at 3 attempts**. If the 3rd attempt is still invalid, abort Option 2 and report "branch name validation failed; no changes made; return to option menu".
3. **Detect whether there are changes to move**. Run `git status --porcelain`. If empty, set `HAS_CHANGES=false`; otherwise `HAS_CHANGES=true`.
4. If `$HAS_CHANGES` is true, stash everything including untracked files in a single command (`-u` is critical — without it, untracked files would remain on the base branch and be exposed to any subsequent cleanup). Record the stash SHA explicitly so later pops are resilient against parallel sessions:
   ```bash
   git stash push -u -m "retroactive-branch-$NAME" || { echo "stash failed; aborting — working tree unchanged"; exit 1; }
   STASH_REF=$(git rev-parse stash@{0})
   ```
   `git stash push -u` **includes untracked files** (critical to avoid silent data loss) and **automatically clears the working tree** (no separate `reset --hard` / `git clean` needed — and **never run `git clean -fd`** in this flow because untracked files are now inside the stash, not on disk).
5. Create and switch to new branch: `git checkout -b "$NAME"`. **If checkout fails**, restore original state on the base branch and abort:
   ```bash
   if [ "$HAS_CHANGES" = "true" ]; then
       git stash pop "$STASH_REF" || echo "WARNING: stash pop conflict — stash entry retained as $STASH_REF; resolve manually"
   fi
   echo "checkout -b failed; reverted to base branch"
   # do NOT proceed to step 6
   ```
6. If `$HAS_CHANGES` is true, apply the stash on the new branch:
   ```bash
   git stash pop "$STASH_REF" || echo "WARNING: stash pop conflict on new branch — stash $STASH_REF retained; resolve manually with 'git stash apply' or 'git stash drop'"
   ```
   Conflicts at this step are extremely rare (the new branch starts identical to base), but if they occur the stash entry is retained so the architect can recover.
7. Prompt the architect to commit and create PR (standard PR flow).
8. Report: "Moved uncommitted changes to branch [name]. Ready to commit and PR." — or, if `$HAS_CHANGES` was false, "Created empty branch [name] — no uncommitted changes to move."

##### Option 3: Hold
1. Report: "Uncommitted changes on [base] are held. Resume anytime."
2. Do NOT push or commit

##### Option 4: Discard
1. **Require explicit confirmation** via AskUserQuestion:
   "Type 'discard' to confirm reverting all uncommitted changes on [base]. This cannot be undone."
2. Only on exact confirmation:
   - `git restore .`
   - (if untracked files exist, prompt before running `git clean -fd`)
3. Report: "Uncommitted changes on [base] discarded."

### Step 5: Cleanup

1. **Archive plan file**: If a plan was active during this session, call `mcp__plugin_qult_qult__archive_plan({ plan_path: "<path>" })` to move the plan file to `archive/` subdirectory. This prevents the plan from being detected in future sessions. Get the plan path from `get_session_status` or the plan file location in `.claude/plans/`.

2. **Worktree cleanup**: If the branch was a git worktree:
   - `git worktree remove [path]` (after merge/discard)
   - Report worktree cleanup status

## Anti-Patterns

- **Open-ended questions**: "What would you like to do?" → Present the 4 options instead
- **Skipping verification**: "Tests probably pass" → Run them. Proof or Block.
- **Merging to main without asking**: NEVER merge without the architect's explicit choice
- **Silent discard**: ALWAYS require typed confirmation for discard
