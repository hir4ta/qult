# Wave 3: SQLite removal

**Goal**: 既存 16 MCP tool handler の内部実装を SQLite → file-based 状態モジュールに切り替え、`src/state/db.ts` 等の SQLite モジュールを削除する。`grep -r "bun:sqlite" src/` がゼロになる。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。`grep -r "bun:sqlite" src/` 空。state テストが新 file-based モジュールに更新済み。
**Started at**: 2026-04-25T15:00:00Z
**Completed at**: 2026-04-25T15:18:00Z
**Scaffold**: false

## Commits

- 3f04974: [wave-03] chore: start Wave 3 (SQLite removal, incremental per-handler swap)
- 08f174d: [wave-03] feat: add gate-state.ts (file-based isGateDisabled), switch 5 detectors away from session-state
- 2ccef59: [wave-03] feat: file-based audit-log + assertConfinedToQult tolerates nonexistent .qult/
- cdd9e79: [wave-03] feat: switch disable_gate/enable_gate handlers to gate-state.ts (file-based)
- e2495a7: [wave-03] chore: mark Wave 3 PARTIAL — 4/9 sub-tasks done, remaining tracked in wave-03.md
- 608611a: [wave-03] feat: switch all DB handlers to file-based + delete SQLite modules and tests

**Range**: 3f04974..608611a

## Notes

- 全 record_* / get_* / clear_pending_fixes / set_config handler を `json-state.ts` / `gate-state.ts` / `audit-log.ts` ベースに切替
- `src/config.ts` を file-based config.json 読み込みに書換（global_configs / project_configs テーブル依存を削除）
- 削除した SQLite モジュール: `src/state/db.ts` / `session-state.ts` / `plan-status.ts` / `pending-fixes.ts`（旧）
- `src/state/flush.ts` は no-op stub に縮小（テストの resetAllCaches 互換性維持）
- 削除した SQLite テスト: `db.test.ts` / `session-state.test.ts` / `state/__tests__/plan-status*.test.ts` / `state/__tests__/pending-fixes.test.ts` / `state/__tests__/flush.test.ts` / `state/__tests__/session-state-history.test.ts`
- `src/__tests__/mcp-server.test.ts` を file-based test に全面書換（61 → 30 テスト、676 → 281 行、無関係な DB 検証を削除）
- `src/__tests__/config.test.ts` を file-based config.json テストに全面書換（38 → 11 テスト、深い DB 階層化テストを削除）
- 書換後の test 数: 521 → 383（DB-only テストが消えた分）
- net diff: 888 insertions / 4241 deletions = **-3353 行**（大幅削減）
- `bun:sqlite` import: 0
- test 中の git commit は 1Password 認証エージェントを呼ばないよう、test repo 内のみ `commit.gpgsign false` を設定（ホストの git config には影響なし）

## 設計上の deviation 記録

tasks.md の Wave 2 と Wave 3 の境界が当初計画と異なる。Wave 2 は registry 構造移行 + 新 spec tool 追加 + 軽量 rename に縮小し、Wave 3 で SQLite path 切替 + モジュール削除 + テスト書換 を一括実施。各 Wave boundary で build / test green を維持できた。
