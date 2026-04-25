# Wave 1: 基盤 / 依存追加 / dashboard スケルトン

**Goal**: `qult dashboard` が起動して "Hello qult" が ink で表示される。既存 CLI コマンドへの影響ゼロ。

**Verify**:
- `bun run typecheck && bun run lint && bun run build` 成功
- `node dist/cli.js dashboard` で ink 画面が立ち上がり、`q` または `Ctrl+C` で終了する
- `node dist/cli.js check` の cold start が 100ms 以内の悪化に収まる (簡易計測)
- `bun test` 全 pass

**Started at**: 2026-04-25T17:05:38Z
**Scaffold**: false

## Commits
(populated on /qult:wave-complete)

**Range**:

## Notes
**Start commit**: 4006f0b91d250cecfa5ab9ce6ddcb17a802df2dd
