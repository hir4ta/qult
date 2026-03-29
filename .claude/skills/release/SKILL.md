---
name: release
description: Release qult. Version can be specified or auto-detected
allowed-tools: Bash(bun *, git *, gh *), Read, Edit, Glob, Grep
---

Release qult.

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
bun tsc --noEmit
bun vitest run
bun build.ts
```

## Version Update

1. Edit `version` in `package.json`
2. Edit `version` in `plugin/.claude-plugin/plugin.json`
3. Edit `version` in `.claude-plugin/marketplace.json` (`plugins[0].version`)
4. Update the version badge in `README.md`:
   - Find: `![Version](https://img.shields.io/badge/version-<OLD_VERSION>-7fbbb3?style=flat-square)`
   - Replace with: `![Version](https://img.shields.io/badge/version-<NEW_VERSION>-7fbbb3?style=flat-square)`

## Build

```
bun build.ts
```

Verify `plugin/dist/hook.mjs` and `plugin/dist/mcp-server.mjs` exist.

## Commit & Tag

1. Stage: `git add package.json plugin/.claude-plugin/ .claude-plugin/ README.md plugin/dist/` (+ other files if agreed with user)
2. Commit message: `v<VERSION>: <one-line summary of commits>` (in English)
   - Generate summary from `git log <prev-tag>..HEAD --oneline`
   - **NEVER add Co-Authored-By** (public repository)
3. `git tag v<VERSION>`

## Push

**NEVER use `--tags`** (pushes all local tags)

```
git push origin main
git push origin v<VERSION>
```

## Verify Release

```
gh release create v<VERSION> --generate-notes
gh release view v<VERSION>
```

## Completion Report

| Item | Value |
|------|-------|
| Version | v<VERSION> |
| Commit | <hash> |
| Release URL | https://github.com/hir4ta/qult/releases/tag/v<VERSION> |
