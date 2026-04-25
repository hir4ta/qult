---
name: status
description: "Show qult project state: active spec phase / Wave / task counts, pending fixes, test pass, review completion. Pass `archive` to list archived specs instead. Use before any commit."
argument-hint: "[archive]"
user-invocable: true
---

# /qult:status

Snapshot of the current project's qult state.

## Default mode (no args)

1. Call `mcp__plugin_qult_qult__get_active_spec()` for the active spec block.
2. Call `mcp__plugin_qult_qult__get_pending_fixes()` for detector findings.
3. Call `mcp__plugin_qult_qult__get_project_status()` for test/review/finish timestamps.
4. Run `git rev-parse --abbrev-ref HEAD` to surface the current branch (the spec is decoupled from branch but mismatched workflows often show up here — e.g. an active spec on `main`).

### Output

```
Branch:     <name>
Active spec: <name> · phase=<implementation> · Wave <N>/<total>  (tasks: ✓3 / ⏳1 / 🚫0 / ⬜2)

Tests:      passed at <ts> via "<command>"
Review:     completed at <ts> · score 32/40
Finish:     not started

Pending fixes: 2 (high)
  [security-check] src/auth.ts:5  hardcoded secret
  [test-quality]   src/__tests__/foo.test.ts:1  always-true assertion
```

If no active spec:
```
Branch: <name>
No active spec.   Run /qult:spec <name> "<description>" to create one.
```

If `get_active_spec` throws "multiple active specs", surface that as a clear error and stop:
```
ERROR: multiple non-archived specs detected: <a>, <b>
This is an inconsistent state — manually move one to .qult/specs/archive/<name>/.
```

## Archive mode (`/qult:status archive`)

List `.qult/specs/archive/*/` directories with their last commit timestamps:

```bash
for d in .qult/specs/archive/*/; do
  name="$(basename "$d")"
  last=$(git log -1 --format='%cI' -- "$d" 2>/dev/null || echo unknown)
  echo "  $name — archived at $last"
done
```

If `.qult/specs/archive/` is empty or missing: `No archived specs.`

## Branch-switch warning

If `active_spec` is non-null AND `git rev-parse HEAD` differs from the most recent commit that touched `.qult/specs/<name>/`, print:

```
⚠ active spec was last edited on a different branch — consider /qult:wave-start before resuming, or run `git log -1 -- .qult/specs/<name>/` to inspect.
```

## Don'ts

- Don't auto-fix anything from `/qult:status`. It is a read-only report.
- Don't fetch `git fetch origin` — local view only.
