# Wave 5: Existing skill updates and workflow rules

**Goal**: 既存 9 skill (init / status / finish / doctor / config / skip / update / uninstall / review) を SDD ライフサイクルに合わせて書換、5 workflow rules を再生成。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。`plugin/rules/qult-spec-mode.md` が存在し `qult-plan-mode.md` は削除されている。skill / rule / agent から "v1.0" 等の version stamp を排除。
**Started at**: 2026-04-25T15:23:00Z
**Completed at**: 2026-04-25T15:30:00Z
**Scaffold**: false

## Commits

- bf684e9: [wave-05] feat: rewrite 9 skills + 5 workflow rules for SDD lifecycle, drop v1.0 markers

**Range**: bf684e9..bf684e9

## Notes

- /qult:init: `.qult/` bootstrap、`.gitignore` 衝突検知、`~/.qult/qult.db` 削除案内、legacy `.claude/rules/qult-plan-mode.md` cleanup
- /qult:status: 引数なしで active spec 情報、`/qult:status archive` で archive 一覧、branch 切替警告、multiple spec エラーの surface
- /qult:finish: Step 5 archive を `archive_spec({ spec_name })` に書換、Hold/Discard では archive しない
- /qult:doctor: SQLite check 撤廃、`.qult/` layout / `.gitignore` 整合性 / state file の git ls-files チェック
- /qult:config: file-based `.qult/config.json` 中心、`spec_eval.thresholds` 解説追加、`plan_eval.*` deprecated alias 表記
- /qult:skip: reason 必須化を文書化、disabled gates が file-based で session 跨ぎ持続することを明記
- /qult:update: rule list を `qult-spec-mode.md` 含む 5 ファイルに更新、旧 plan-mode.md remove ステップ追加
- /qult:uninstall: legacy v0.x SQLite store と project-local `.qult/` 削除を分離、spec markdown は keep 推奨
- /qult:review: Stage 0.5 を `.claude/plans/` から `.qult/specs/<active>/tasks.md` に切替、`<untrusted-spec-tasks-${NONCE}>` フェンス導入
- 5 rules を全面書換: `qult-spec-mode.md` 新規、`qult-workflow.md` / `qult-pre-commit.md` / `qult-review.md` / `qult-quality.md` を SDD 用語と Wave invariant に再構成
- 全 v1.0 markers を sed で除去 (タイトル / description / 文中の "qult v1.0" 系)
- Wave 5 完了時点で plugin 配布物は完全に SDD モード化 (CLAUDE.md / README / .claude/docs は Wave 6 で更新)
