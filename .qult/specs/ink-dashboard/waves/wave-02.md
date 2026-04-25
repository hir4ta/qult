# Wave 2: 状態取得・watcher・store・event stream

**Goal**: ink を使わない純粋なロジック層を完成させる。`.qult/state/` および `.qult/specs/` の変更を検知し、`DashboardState` が reducer 経由で正しく更新される。UI には未接続。

**Verify**:
- 純粋関数 (computeLayout, EventStream, diff 検出, active spec 解決) の単体テストが pass
- 一時ディレクトリで `.qult/state/*.json` と `waves/wave-NN.md` を変更 → watcher が正しい event を emit する e2e テスト

**Started at**: 2026-04-25T17:15:52Z
**Scaffold**: false

**Completed at**: 2026-04-25T17:22:00Z

## Commits
- eda9abd [wave-02] feat(dashboard): add reducer / watcher / event stream for live state

**Range**: 16e9f79..eda9abd

## Notes
**Start commit**: 16e9f796f8677c440e5025f863ef44c175ab94a7
