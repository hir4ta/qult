---
name: finish
description: "Branch completion workflow. Use when implementation is complete and all tests pass — guides the architect through merge, PR, hold, or discard options. NOT for incomplete work or failing tests."
user-invocable: true
---

# /qult:finish

Structured branch completion. Present options, execute the architect's choice.

> **Proof or Block.**
> No completion claims without fresh verification evidence.
> Tests pass. Review passes. Then — and only then — we finish.

## The Wall

<HARD-GATE>
NO COMPLETION WITHOUT VERIFICATION.
Before presenting options, ALL gates must be clear.
If tests fail, stop. If review is incomplete, stop. The Wall stands.
</HARD-GATE>

## Process

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

1. Check current branch name: `git branch --show-current`
2. Determine the base branch (usually `main` or `master`)
3. Show the architect the summary:

```
Branch: feature/xyz
Base: main
Commits: N (ahead of base)
Changed files: N
Tests: PASSED
Review: PASSED (Score: N/30)
```

### Step 3: Present Options

Present exactly these 4 options. No more, no fewer. No open-ended questions.

```
How would you like to finish this branch?

1. **Merge** — Merge into [base] and delete the branch
2. **PR** — Push and create a pull request for team review
3. **Hold** — Keep the branch as-is for later
4. **Discard** — Delete the branch and all changes
```

Use AskUserQuestion with these exact options. Wait for the architect's choice.

### Step 4: Execute Choice

#### Option 1: Merge
1. `git checkout [base]`
2. `git merge [branch] --no-ff`
3. `git branch -d [branch]`
4. Report: "Merged [branch] into [base]. Branch deleted."

#### Option 2: PR
1. `git push -u origin [branch]`
2. Create PR via `gh pr create`:
   - Title: concise summary of the change
   - Body: summary of changes, test plan
3. Report: "PR created: [URL]"

#### Option 3: Hold
1. Optionally push: ask the architect "Push to remote for backup?"
2. Report: "Branch [branch] is on hold. Resume anytime."

#### Option 4: Discard
1. **Require explicit confirmation** via AskUserQuestion:
   "Type 'discard' to confirm deleting branch [branch] and all its changes. This cannot be undone."
2. Only on exact confirmation:
   - `git checkout [base]`
   - `git branch -D [branch]`
3. Report: "Branch [branch] discarded."

### Step 5: Cleanup

If the branch was a git worktree:
1. `git worktree remove [path]` (after merge/discard)
2. Report worktree cleanup status

## Anti-Patterns

- **Open-ended questions**: "What would you like to do?" → Present the 4 options instead
- **Skipping verification**: "Tests probably pass" → Run them. Proof or Block.
- **Merging to main without asking**: NEVER merge without the architect's explicit choice
- **Silent discard**: ALWAYS require typed confirmation for discard
