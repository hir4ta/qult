# Wave 3: SQLite removal

**Goal**: 既存 16 MCP tool handler の内部実装を SQLite → file-based 状態モジュールに切り替え、`src/state/db.ts` 等の SQLite モジュール 6 ファイル + 旧 `src/config.ts` を削除する。`grep -r "bun:sqlite" src/` がゼロになる。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。`grep -r "bun:sqlite" src/` 空。state テストが新 file-based モジュールに更新済み。
**Started at**: 2026-04-25T15:00:00Z
**Completed at**: (PARTIAL — checkpoint, not finalized)
**Scaffold**: false

## Commits (so far)

- 3f04974: [wave-03] chore: start Wave 3 (SQLite removal, incremental per-handler swap)
- 08f174d: [wave-03] feat: add gate-state.ts (file-based isGateDisabled), switch 5 detectors away from session-state
- 2ccef59: [wave-03] feat: file-based audit-log + assertConfinedToQult tolerates nonexistent .qult/
- cdd9e79: [wave-03] feat: switch disable_gate/enable_gate handlers to gate-state.ts (file-based)

**Range** (in-progress): 3f04974..cdd9e79

## Notes

切り替えは handler 単位の incremental 戦略を取る:
1. 不足する file-based モジュールを追加（gate state、audit log）
2. handler を 1 つずつ DB → file 切替、commit
3. 全 handler 切替後に SQLite モジュール群削除
4. SQLite 専用テスト群を削除し、新モジュールテストでカバレッジを補完

各 commit で build / test green を維持する。

## Status: PARTIAL — checkpoint suspended for budget

Wave 3 はサイズが想定より大きく、1 セッションでの完遂は非現実的と判断。以下は完了済み（build / 521 tests green に到達）:

- ✅ `src/state/gate-state.ts` 追加（disabled_gates 置換）
- ✅ 5 detectors を session-state.ts → gate-state.ts に切替
- ✅ `src/state/audit-log.ts` を SQLite → file-based ndjson に書換
- ✅ `assertConfinedToQult` を nonexistent .qult/ 対応
- ✅ `disable_gate` / `enable_gate` handler を gate-state.ts ベースに切替
- ✅ 関連テストを file-based に書換（mcp-server.test.ts 一部、audit-log.test.ts 全面）

## 残タスク（次セッションで継続）

- ⏳ `record_test_pass` / `record_review` / `record_human_approval` / `record_finish_started` / `record_stage_scores` の handler を DB → `json-state.ts` (current.json / stage-scores.json) に切替
- ⏳ `get_project_status` の読み取りを DB projects テーブル → current.json / stage-scores.json + 既存 active_spec field
- ⏳ `get_pending_fixes` / `clear_pending_fixes` を DB → `json-state.ts` pending-fixes に切替
- ⏳ `set_config` を DB project_configs → config.json に切替
- ⏳ `src/config.ts` の DB 依存を `src/state/config.ts` に移管、旧 `src/config.ts` 削除
- ⏳ `mcp-server.ts` から `getDb / getProjectId / setProjectPath` import を削除
- ⏳ SQLite モジュール削除: `src/state/{db, session-state, plan-status, flush}.ts`
- ⏳ SQLite 専用テスト削除/書換: `db.test.ts`, `session-state*.test.ts`, `plan-status*.test.ts`, `flush.test.ts`, 旧 `pending-fixes.test.ts`
- ⏳ `bun:sqlite` import の完全消滅を `grep -r` で確認

これら完了後に Wave 3 を本完了として Range 確定 + tasks.md チェックボックス更新。
