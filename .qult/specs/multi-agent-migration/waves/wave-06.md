# Wave 6: `plugin/` 削除・npm 配布準備

**Goal**: 旧 `plugin/` ディレクトリ・`build.ts`・`src/hooks/`（存在する場合）を削除し、npm 配布物として完結した状態を確認する。E2E smoke test が全通過することを検証してから削除を実行する。
**Verify**: `bun run typecheck && bun run test && bun run build && npm pack --dry-run && node dist/cli.mjs init --help`
**Started at**: 2026-04-25T12:23:00Z
**Scaffold**: false

## Commits
(populated on /qult:wave-complete)

**Range**:

## Notes
**Start commit**: 5e6092ea3ece1d37a2647df99f7e76c56e2da61e
