# Wave 1: Filesystem foundation

**Goal**: SQLite を撤廃せず、`.qult/` ファイルベースの新 state モジュール群を**追加**する。既存 SQLite 実装と共存し、ビルド・全テストが pass する状態を維持する。
**Verify**: `bun run typecheck && bun run lint && bun run test` が pass。新規モジュールの単体テスト（atomic write、markdown parser round-trip、paths 算出、realpath による `.qult/` 配下検証、spec_name 検証）が pass。
**Started at**: 2026-04-25T13:50:00Z
**Completed at**: 2026-04-25T14:25:00Z
**Scaffold**: true

## Commits

- d93a552: [wave-01] feat: add paths.ts (.qult/ path resolution + validators)
- 8086118: [wave-01] feat: add fs.ts (atomic write + JSON schema_version IO)
- ac059bd: [wave-01] feat: add tasks-md.ts (parser + setTaskStatus + TaskNotFoundError)
- 06a0cc5: [wave-01] fix: tasks-md.ts の制御文字 regex を Unicode escape で表記
- 72c928a: [wave-01] feat: add wave-md.ts (wave-NN.md parser/writer, no task list duplication)
- f042e17: [wave-01] feat: add spec.ts (active spec detection, archive, range reachability)
- cd939cd: [wave-01] feat: add json-state.ts (current/pending-fixes/stage-scores file IO)
- fd00581: [wave-01] test: add unit tests for new state modules (64 tests, all green)

**Range**: d93a552..fd00581

## Notes

- Wave 1 は scaffold = true で test 実行は新規 64 テストのみ確認。既存 505 テストも全て green を維持。
- T1.6 の 3 モジュール（current / pending-fixes / stage-scores）は `src/state/json-state.ts` に集約。tasks.md の記述よりファイル数を 1 つに減らした（KISS、各 ~70 行で分割不要と判断）。
- 既存 SQLite 系モジュールは未変更で並走中。Wave 2 で MCP tool 側を新 state モジュールに切り替え、Wave 3 で SQLite 系を削除する予定。
- Range の前端 `d93a552` は Wave 1 最初の commit、後端 `fd00581` は test commit。間に fix commit が 1 つ含まれる（range は連続するので問題なし）。
