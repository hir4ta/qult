# Wave 3: SQLite removal

**Goal**: 既存 16 MCP tool handler の内部実装を SQLite → file-based 状態モジュールに切り替え、`src/state/db.ts` 等の SQLite モジュール 6 ファイル + 旧 `src/config.ts` を削除する。`grep -r "bun:sqlite" src/` がゼロになる。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。`grep -r "bun:sqlite" src/` 空。state テストが新 file-based モジュールに更新済み。
**Started at**: 2026-04-25T15:00:00Z
**Completed at**:
**Scaffold**: false

## Commits

(populated on /qult:wave-complete)

**Range**:

## Notes

切り替えは handler 単位の incremental 戦略を取る:
1. 不足する file-based モジュールを追加（gate state、audit log）
2. handler を 1 つずつ DB → file 切替、commit
3. 全 handler 切替後に SQLite モジュール群削除
4. SQLite 専用テスト群を削除し、新モジュールテストでカバレッジを補完

各 commit で build / test green を維持する。
