---
name: release
description: Release claude-alfred. Version can be specified or auto-detected
allowed-tools: Bash(npm *, node *, git *, gh *), Read, Edit, Glob, Grep, Write
---

Release claude-alfred.

## Version Detection

Arguments: `$ARGUMENTS`

- If a version is specified (e.g., `0.1.0`, `v0.2.0`) → use it (strip `v` prefix)
- If empty → auto-detect:
  1. Get latest tag via `git describe --tags --abbrev=0`
  2. Get commit list via `git log <latest-tag>..HEAD --oneline`
  3. Analyze commit messages for semver bump:
     - **minor bump** (0.1.x → 0.2.0): commits contain feature keywords (Add, feat, new feature, implement, etc.)
     - **patch bump** (0.1.0 → 0.1.1): everything else (fix, refactor, improve, optimize, update, chore, test, etc.)
  4. Show detected version and reasoning to user, get confirmation before proceeding

## Pre-checks

1. Check working tree with `git status`
2. If uncommitted changes exist → ask user whether to include in release commit
3. If no changes and no commits since last tag → abort (nothing to release)

## Validation Gate

Run in order; **abort release if any fails**:

```
npm run typecheck
npm test
npm run build
```

## Version Update (3 files)

1. `npm version <VERSION> --no-git-tag-version` — updates package.json + package-lock.json
2. Update `plugins[0].version` in `.claude-plugin/marketplace.json` to `<VERSION>`
3. Update `version` in `plugin/.claude-plugin/plugin.json` to `<VERSION>`

All 3 must match. This is the version that Claude Code uses for plugin caching.

## Commit & Tag

1. Stage release files: `git add package.json package-lock.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json`
   - Include other uncommitted files if agreed with user
2. Commit message: `v<VERSION>: <one-line summary of commits>` (in English)
   - Generate summary from `git log <prev-tag>..HEAD --oneline`
   - **NEVER add Co-Authored-By** (public repository)
3. `git tag v<VERSION>`

## Push & CI

**NEVER use `--tags`** (pushes all local tags)

```
git push origin main
git push origin v<VERSION>
```

### CI Monitoring

1. `gh run list --limit 1` — check Release workflow started
2. `gh run watch <run-id>` — watch until completion
3. If CI fails → fix the issue, delete the tag (`git tag -d v<VERSION> && git push origin :refs/tags/v<VERSION>`), and re-release

## Verify Release

After CI succeeds:
```
gh release view v<VERSION>
npm view claude-alfred version
```

## Completion Report

| Item | Value |
|------|-------|
| Version | v<VERSION> |
| Commit | <hash> |
| CI | success/failure (duration) |
| npm | https://www.npmjs.com/package/claude-alfred |
| Release URL | https://github.com/hir4ta/claude-alfred/releases/tag/v<VERSION> |
