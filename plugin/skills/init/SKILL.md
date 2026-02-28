---
name: init
description: >
  Re-sync sessions and regenerate embeddings. Binary updates are automatic —
  this skill is only needed for manual re-sync or after setting VOYAGE_API_KEY.
user-invocable: true
allowed-tools: Bash, AskUserQuestion
---

Re-sync claude-buddy data (sessions, patterns, embeddings).

Note: Binary updates happen automatically when the plugin is updated via /plugin.
This skill is useful for:
- Manual re-sync after setting VOYAGE_API_KEY
- Forcing a full session re-sync

## Steps

1. Find the plugin installation directory:
   ```bash
   find ~/.claude/plugins/cache -name "run.sh" -path "*/claude-buddy/*/bin/*" -type f 2>/dev/null | sort -V | tail -1
   ```

2. Count available sessions per sync range:
   ```bash
   sh <path-to-run.sh> count-sessions
   ```
   This returns JSON with session counts and estimated minutes per range.

3. Ask the user which sync range to use with AskUserQuestion:
   - Use the session counts and est_minutes from step 2 to build descriptions
   - Options (use actual counts from JSON):
     - "Past 1 week" — description: "{sessions} sessions, ~{est_minutes} min"
     - "Past 2 weeks" — description: "{sessions} sessions, ~{est_minutes} min"
     - "Past 1 month (Recommended)" — description: "{sessions} sessions, ~{est_minutes} min"
     - "Past 3 months" — description: "{sessions} sessions, ~{est_minutes} min"
   - If has_voyage_key is true, append to the question text: "Embedding generation (vector search) runs after sync and is included in the time estimate."
   - Map the user's choice to a --since flag: 1 week=7d, 2 weeks=14d, 1 month=30d, 3 months=90d

4. Run setup with the chosen range (set timeout to 600000):
   ```bash
   sh <path-to-run.sh> setup --since=<chosen_flag>
   ```

5. Verify:
   ```bash
   sh <path-to-run.sh> version
   ```

## Output

- Sync status and version
- Tell the user to restart Claude Code if the binary was updated
