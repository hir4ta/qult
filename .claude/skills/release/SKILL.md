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

Run in order; **abort release if any fails**. Use the project's package.json scripts to ensure the correct Bun runtime:

```
bun run typecheck
bun run lint
bun run test
bun run build
```

## Version Update

Update `version` in these 2 files only:

1. `plugin/.claude-plugin/plugin.json`
2. `.claude-plugin/marketplace.json` (`plugins[0].version`)

## Build

```
bun build.ts
```

Verify `plugin/dist/mcp-server.mjs` exists.

## Commit & Tag

1. Stage: `git add plugin/.claude-plugin/ .claude-plugin/ plugin/dist/` (+ other files if agreed with user)
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

## CI Verification

**Push 後、必ず CI の完了を確認する。CI が失敗した場合はリリース未完了として扱う。**

1. `gh run watch` で最新の CI run を監視（完了まで待機）
2. CI が **success** → GitHub Release 作成に進む
3. CI が **failure** → 以下を実施:
   a. `gh run view <run-id> --log-failed` でエラー内容を確認
   b. エラーを修正してコミット
   c. **タグを打ち直す**: `git tag -d v<VERSION> && git push origin :refs/tags/v<VERSION>`
   d. 修正コミット後に再タグ: `git tag v<VERSION> && git push origin main && git push origin v<VERSION>`
   e. 再度 `gh run watch` で CI 成功を確認
   f. 成功するまでこのループを繰り返す

## Create Release

CI 成功を確認した後のみ実行:

```
gh release create v<VERSION> --generate-notes
gh release view v<VERSION>
```

## Completion Report

| Item | Value |
|------|-------|
| Version | v<VERSION> |
| Commit | <hash> |
| CI | PASSED |
| Release URL | https://github.com/hir4ta/qult/releases/tag/v<VERSION> |
