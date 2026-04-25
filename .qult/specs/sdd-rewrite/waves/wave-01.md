# Wave 1: Filesystem foundation

**Goal**: SQLite を撤廃せず、`.qult/` ファイルベースの新 state モジュール群を**追加**する。既存 SQLite 実装と共存し、ビルド・全テストが pass する状態を維持する。
**Verify**: `bun run typecheck && bun run lint && bun run test` が pass。新規モジュールの単体テスト（atomic write、markdown parser round-trip、paths 算出、realpath による `.qult/` 配下検証、spec_name 検証）が pass。
**Started at**: 2026-04-25T13:50:00Z
**Completed at**:
**Scaffold**: true

## Commits

(populated on /qult:wave-complete)

**Range**:

## Notes

`/qult:wave-start` skill はまだ存在しないため、wave-01.md を手動で初期化。Wave 1 完了時に Range と Completed at を埋める。Wave 1 は scaffold で SQLite と新モジュールが並走するため、既存テストは影響を受けない想定。
