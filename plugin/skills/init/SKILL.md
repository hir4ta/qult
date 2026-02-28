---
name: init
description: >
  Re-sync sessions and regenerate embeddings. Binary updates are automatic —
  this skill is only needed for manual re-sync or after setting VOYAGE_API_KEY.
user-invocable: true
allowed-tools: Bash
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

2. Run setup (downloads binary if needed + syncs sessions + generates embeddings):
   ```bash
   sh <path-to-run.sh> setup
   ```

3. Verify:
   ```bash
   sh <path-to-run.sh> version
   ```

## Output

- Sync status and version
- Tell the user to restart Claude Code if the binary was updated
