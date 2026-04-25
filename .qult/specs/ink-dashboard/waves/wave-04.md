# Wave 4: 動的レイアウト・終了・仕上げ

**Goal**: ターミナル幅・高さ変化に追従して綺麗にレイアウトが組み変わる。終了処理・非 TTY フォールバック・エラー表示が完成。

**Verify**:
- 40 / 60 / 90 / 150 桁で起動し、それぞれ narrow / medium / wide tier に切り替わる
- リサイズ中チラつきがない (hysteresis 効いている)
- `q` / `Ctrl+C` で即終了、ターミナル復元
- 非 TTY (`qult dashboard | cat`) で plain snapshot が 1 度だけ出る
- 壊れた JSON を読んだ際に Alert が出るが UI は維持

**Started at**: 2026-04-25T17:28:00Z
**Scaffold**: false

**Completed at**: 2026-04-25T17:32:00Z

## Commits
- c20403f [wave-04] feat(dashboard): dynamic layout, error banner, plain-text non-TTY fallback

**Range**: f191ced..c20403f

## Notes
**Start commit**: f191ced35e9c8b8341d11a0d7d44e9da64b65671
