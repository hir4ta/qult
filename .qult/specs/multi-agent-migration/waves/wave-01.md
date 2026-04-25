# Wave 1: プロジェクト再構築・State 移植

**Goal**: `src/state/`・`src/types.ts`・`src/detector/network.ts` を Node.js 向けに移植し、`tsup` でビルドが通る最小シェルを確立する。既存 `plugin/` は残したまま並行開発を開始できる状態にする。
**Verify**: `bun run typecheck && bun run build && node dist/cli.mjs --version`
**Started at**: 2026-04-25T11:30:00Z
**Completed at**: 2026-04-25T11:40:35.365Z
**Scaffold**: true

## Commits

(populated on /qult:wave-complete)

**Range**: e9dd5ac..da6e572

## Notes

**Start commit**: e9dd5ac69a5de312bd40276e8c9ed3964deaff4d
