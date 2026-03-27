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

Edit `version` in `package.json` only (no plugin files in v1).

## Commit & Tag

1. Stage: `git add package.json` (+ other files if agreed with user)
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

Tag push triggers `.github/workflows/release.yml` which:
- Builds 4 platform binaries (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
- Creates GitHub Release with auto-generated release notes + all artifacts

Monitor:
1. `gh run list --limit 1` — check Release workflow started
2. `gh run watch <run-id>` — watch until completion
3. If CI fails → fix the issue, delete the tag (`git tag -d v<VERSION> && git push origin :refs/tags/v<VERSION>`), and re-release

## Post-Release: Build & Install

After CI succeeds, rebuild and install locally:

```
bun build.ts
qult init
bun link
qult doctor
```

All 4 commands must succeed. `qult doctor` must show all `[OK]`.

## Verify Release

After post-release install:
```
gh release view v<VERSION>
```

## Completion Report

| Item | Value |
|------|-------|
| Version | v<VERSION> |
| Commit | <hash> |
| CI | success/failure (duration) |
| Release URL | https://github.com/hir4ta/qult/releases/tag/v<VERSION> |
