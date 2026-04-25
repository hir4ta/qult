---
name: release
description: Release qult. Version can be specified or auto-detected
allowed-tools: Bash(npm *, npx *, git *, gh *), Read, Edit, Glob, Grep
---

Release qult to GitHub (tag + release notes) and prepare for npm publish.

The skill stops just before `npm publish` because npm 2FA requires interactive
input — the architect runs `! npm publish` themselves after the dry-run passes.

## Version Detection

Arguments: `$ARGUMENTS`

- If a version is specified (e.g., `0.1.0`, `v0.2.0`) → use it (strip `v` prefix).
- If empty → auto-detect:
  1. Get latest tag via `git describe --tags --abbrev=0`.
  2. Get commit list via `git log <latest-tag>..HEAD --oneline`.
  3. Decide the bump:
     - **major** (X.0.0): any commit subject contains `!:` (Conventional Commits breaking marker), e.g. `chore!:`, `feat!:`, or `BREAKING CHANGE` in the body.
     - **minor** (x.Y.0): at least one `feat:` / `feat(scope):` / "Add" / "implement" / "new feature".
     - **patch** (x.y.Z): everything else (`fix`, `refactor`, `chore`, `docs`, `test`, etc.).
  4. Show the detected version and reasoning to the architect; get confirmation before proceeding.

## Pre-checks

1. `git status` must be clean. If uncommitted changes exist → ask the architect whether to include them in the release commit (separate commit before tagging).
2. If no commits since the last tag → abort with "nothing to release".
3. Verify `package.json` `version` field matches the target version. If not, update it (single file change, then commit `chore: bump version to v<VERSION>` before tagging).

## Validation Gate

Run via npm scripts; abort release if any fails.

```
npm run typecheck
npm run lint
npm test
npm run build
```

## Commit & Tag

If the version field was just bumped, commit it first:

```
git add package.json package-lock.json
git commit -m "chore: bump version to v<VERSION>"
```

Then tag (annotated tag with the same message format):

```
git tag v<VERSION>
```

Do NOT add Co-Authored-By (public repository).

## Push

NEVER use `--tags` (pushes all local tags).

```
git push origin main
git push origin v<VERSION>
```

## CI Verification

Push 後、必ず CI の完了を確認する。CI が失敗した場合はリリース未完了として扱う。

1. `gh run watch <run-id> --exit-status` で最新の CI run を監視（完了まで待機）。
2. CI が **success** → GitHub Release 作成へ。
3. CI が **failure** →
   a. `gh run view <run-id> --log-failed` で原因確認。
   b. 修正コミット。
   c. タグを打ち直す: `git tag -d v<VERSION> && git push origin :refs/tags/v<VERSION>`。
   d. 修正後に再タグ: `git tag v<VERSION> && git push origin main && git push origin v<VERSION>`。
   e. 成功するまで繰り返す。

## Create GitHub Release

CI 成功確認後のみ:

```
gh release create v<VERSION> --generate-notes
gh release view v<VERSION>
```

## npm publish — dry-run only

This skill **does not invoke `npm publish`** because it requires 2FA OTP input.
After GitHub release succeeds, run the dry-run gate:

```
npm publish --dry-run
```

The `prepublishOnly` script (in `package.json`) runs typecheck/lint/test/build
again as a final guard.

- If dry-run **succeeds**, output:

  ```
  ✅ npm dry-run OK — package contents look good.
  
  Run this yourself to actually publish:
    ! npm publish
  
  (npm 2FA OTP input is required interactively; this skill does not run it.)
  ```

- If dry-run **fails**, surface the npm error verbatim and stop. Do NOT instruct the architect to publish.

## Completion Report

| Item | Value |
|------|-------|
| Version | v<VERSION> |
| Commit | <hash> |
| CI | PASSED |
| GitHub Release | https://github.com/hir4ta/qult/releases/tag/v<VERSION> |
| npm dry-run | PASSED — architect to run `! npm publish` |
