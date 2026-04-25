# Wave 2: MCP tools migrate to new state modules (no deletes)

**Goal**: MCP tool の handler を registry pattern (`src/mcp-tools/`) へ移行し、新規 5 spec tool を追加する。SQLite モジュール群は **Wave 2 では未削除**かつ既存 16 tool は SQLite path を維持。Wave 3 で SQLite → file-based の内部実装切替を行う（Wave 2 では構造変更 + 純粋追加のみで build green を維持）。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。新 spec tool（5 個）の単体テスト pass。`get_session_status` → `get_project_status` リネーム済み。`archive_plan` → `archive_spec` リネーム済みかつ実装は新 `spec.ts` ベース。
**Started at**: 2026-04-25T14:30:00Z
**Completed at**:
**Scaffold**: false

## Commits

(populated on /qult:wave-complete)

**Range**:

## Notes

設計上の deviation: tasks.md T2.1 は「既存 16 tool の内部実装を新 state モジュールに切り替え」を Wave 2 で行う計画だった。実装着手時に「SQLite path 切替 + 全 tool registry 移行を 1 Wave に詰めると既存 28 テスト群を並行修正する必要があり、build green boundary が崩れるリスク」を判断し、以下に分割:

- **Wave 2 (now)**: 純粋追加 + 軽量 rename のみ。具体的には:
  - `src/mcp-tools/shared.ts` (input validators)
  - `src/mcp-tools/spec-tools.ts` (新規 5 spec tool: get_active_spec / complete_wave / update_task_status / archive_spec / record_spec_evaluator_score)
  - `src/mcp-server.ts` の TOOL_DEFS に 5 件追記、dispatch case 5 件追加
  - `get_session_status` → `get_project_status` リネーム + active_spec フィールド追加
  - `archive_plan` → `archive_spec` リネーム + 実装を新 `spec.ts` ベースに差替え
  - 新 tool の単体テスト追加
- **Wave 3 (next)**: 既存 16 tool の内部実装 SQLite → file-based 切替 + SQLite 系モジュール削除 + registry pattern 完全移行 + 既存テスト書き換え。

これにより Wave 2 の差分は新規追加とリネーム 2 件に限定され、既存挙動は無変更で build / test green を維持できる。
