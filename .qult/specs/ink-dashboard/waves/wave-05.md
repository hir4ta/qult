# Wave 5: `qult check --detect` Ink 化

**Goal**: `qult check --detect` 実行中、各 detector の進行が Spinner / Badge / ProgressBar で視覚化される。`--no-tty` で従来出力にフォールバック。

**Verify**:
- TTY で `qult check --detect` を実行 → Spinner が回って各 detector 完了時に Badge に変わる
- 完了後に Alert でサマリ (severity 別) が出る
- `qult check --detect --no-tty` または非 TTY で従来の plain 出力が変わらない
- snapshot テスト pass

**Started at**: 2026-04-25T17:36:00Z
**Completed at**: 2026-04-25T17:38:30Z
**Scaffold**: false

## Commits
(filled after commit)

**Range**:

## Notes
**Start commit**: c20403fe4182862d2a29b6e80eee24034f67a88e
