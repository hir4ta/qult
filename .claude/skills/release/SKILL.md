---
name: release
description: Release claude-alfred. Version can be specified or auto-detected
allowed-tools: Bash(go:*, git:*, gh:*), Read, Edit, Glob, Grep, Write
disable-model-invocation: true
---

Release claude-alfred.

## Version Detection

Arguments: `$ARGUMENTS`

- If a version is specified (e.g., `0.13.14`, `v0.14.0`) → use it (strip `v` prefix)
- If empty → auto-detect:
  1. Get latest tag via `git describe --tags --abbrev=0`
  2. Get commit list via `git log <latest-tag>..HEAD --oneline`
  3. Analyze commit messages for semver bump:
     - **minor bump** (0.13.x → 0.14.0): commits contain feature keywords (Add, feat, new feature, implement, etc.)
     - **patch bump** (0.13.13 → 0.13.14): everything else (fix, refactor, improve, optimize, update, chore, schema, test, etc.)
  4. Show detected version and reasoning to user, get confirmation before proceeding

## Pre-checks

1. Check working tree with `git status`
2. If uncommitted changes exist → ask user whether to include in release commit
3. If no changes and no commits since last tag → abort (nothing to release)

## Validation Gate

Run in order; **abort release if any fails**:

```
go build -o /dev/null ./cmd/alfred
go test ./... -count=1
go vet ./...
```

## Plugin Bundle Update

1. **Check plugin/ source of truth**: `internal/install/content/` (rules, skills, agents) is the source.
   `plugin/` is generated — if plugin/ was edited directly, sync `internal/install/content/` first.
   CI's `Verify plugin bundle is up to date` catches mismatches.
2. Regenerate plugin/ directory (ldflags version injection is **required**):
   ```
   go run -ldflags "-X main.version=<VERSION>" ./cmd/alfred plugin-bundle ./plugin
   ```
   Without ldflags, `version=dev` is used and CI will fail on diff

## README Badges

README.md / README.ja.md のバッジは shields.io の動的バッジ（GitHub tag / license / workflow status）を使用しているため、リリース時の手動更新は不要。

ただし Go バージョンバッジ (`go-%3E%3D1.25`) は静的値。`go.mod` の Go バージョンを上げた場合は README のバッジも更新すること。

## Commit & Tag (Phase 1: Release binary)

1. Stage changed files: `git add plugin/`
   - Include other uncommitted files if agreed with user
   - **DO NOT stage `.claude-plugin/marketplace.json` yet** (marketplace update is Phase 2)
2. Commit message: `v<VERSION>: <one-line summary of commits>` (in English)
   - Generate summary from `git log <prev-tag>..HEAD --oneline`
   - Write as if the developer authored it
   - **NEVER add Co-Authored-By** (public repository)
3. `git tag v<VERSION>`

## Local Binary Update

After tagging, before pushing, update the local `go/bin/alfred` binary:

```
go install -ldflags "-X main.version=<VERSION> -X main.commit=$(git rev-parse --short HEAD) -X main.date=$(date -u +%Y-%m-%dT%H:%M:%SZ)" ./cmd/alfred
```

This ensures `alfred version` immediately returns the new version.
Without ldflags, `go install` uses `version=dev` and vcs fallback shows the old version.

## Push & CI (Phase 1)

**NEVER use `--tags`** (pushes all local tags, causing inconsistencies)

```
git push origin main
git push origin v<VERSION>
```

Always push individually.

### CI Monitoring

1. Check Release workflow started: `gh run list --limit 1`
2. Watch until completion: `gh run watch <run-id>`
3. **If CI fails → abort. Do NOT proceed to Phase 2.** Fix the issue and re-release.

## Marketplace Update (Phase 2: after Release CI succeeds)

**CRITICAL**: Only proceed after GitHub Release is confirmed successful.

1. Verify release assets exist:
   ```
   gh release view v<VERSION> --json assets --jq '.assets[].name'
   ```
   Must include `alfred_darwin_arm64.tar.gz`, `alfred_darwin_amd64.tar.gz`, `alfred_linux_amd64.tar.gz`, `alfred_linux_arm64.tar.gz`, `checksums.txt`
2. Update `plugins[0].version` in `.claude-plugin/marketplace.json`
3. Commit: `chore: update marketplace to v<VERSION>`
4. Push: `git push origin main`

## Completion Report

Display the following on release completion:

| Item | Value |
|------|-------|
| Version | v<VERSION> |
| Commit | <hash> |
| CI | success/failure (duration) |
| Release URL | https://github.com/hir4ta/claude-alfred/releases/tag/v<VERSION> |
