# Tasks: sdd-rewrite

## Wave 1: Filesystem foundation

**Goal**: SQLite を撤廃せず、`.qult/` ファイルベースの新 state モジュール群を**追加**する。既存 SQLite 実装と共存し、ビルド・全テストが pass する状態を維持する（scaffold Wave）。
**Verify**: `bun run typecheck && bun run lint && bun run test` が pass。新規モジュールの単体テスト（atomic write、markdown parser round-trip、paths 算出、realpath による `.qult/` 配下検証、spec_name 検証）が pass。
**Scaffold**: true

- [x] T1.1: `src/state/paths.ts` を新規作成。cwd ベースで `.qult/specs/<name>/{requirements,design,tasks}.md`、`waves/wave-NN.md`（NN は 2 桁ゼロパディング、上限 99）、`state/{current,pending-fixes,stage-scores}.json`、`config.json` の絶対パス算出関数群を export。`spec_name` の正規表現検証（`^[a-z0-9][a-z0-9-]{0,63}$`、`archive` 予約名拒否）と、`realpath` で `.qult/` 配下に閉じることの検証関数も含む。
- [x] T1.2: `src/state/fs.ts` を新規作成。atomic write（`<file>.tmp` → `rename`）、JSON read/write（schema_version 検証含む）、ファイル存在確認、ディレクトリ自動作成のユーティリティを実装。
- [x] T1.3: `src/state/tasks-md.ts` を新規作成。tasks.md の parser と writer。Wave セクション分割、task 行の status 更新（`[ ]` / `[x]` / `[~]` / `[!]`）。task title の制約検証（改行・制御文字・1024 文字以内）、ファイルサイズ上限 1 MiB。parse 失敗時は例外を投げ元ファイルを破壊しない。`update_task_status` 用に存在しない `task_id` を渡されたら明示的に `task_not_found` エラーを返す。
- [x] T1.4: `src/state/wave-md.ts` を新規作成。wave-NN.md の parser と writer（task list は持たない、Goal/Verify/Scaffold/Range/Fixes/Superseded by/Commits/Notes セクションのみ）。`tasks-md.ts` とは grammar が異なるため別モジュールとして実装。
- [x] T1.5: `src/state/spec.ts` を新規作成。active spec の判定（`.qult/specs/` 走査、`archive/` 除外）、archive 移動（衝突時タイムスタンプ suffix）、wave-NN.md 生成、spec phase 推定、Range SHA reachability 検証ヘルパー（`git rev-parse --verify <sha>^{commit}`）。
- [x] T1.6: `src/state/current.ts` / 新版 `src/state/pending-fixes.ts` / `src/state/stage-scores.ts` を新規作成。各 JSON ファイルの read/write を担当。`stage-scores.ts` は新 spec 確定時に `spec_eval` ブロックを初期化する関数を提供。
- [x] T1.7: 上記 6 モジュールに対する単体テストを `src/__tests__/` 配下に追加し、`bun run typecheck && bun run lint && bun run test` が全 pass することを確認、Wave 1 完了。

## Wave 2: MCP tools migrate to new state modules (no deletes)

**Goal**: MCP tool の handler を新 state モジュール群に切り替え、新規 5 tool を追加する。SQLite モジュール群は**まだ削除しない**（共存維持、build / test green を確実にする）。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。新 MCP tool（`get_active_spec`、`complete_wave`、`update_task_status`、`archive_spec`、`record_spec_evaluator_score`）の単体テスト pass。`get_session_status` → `get_project_status` リネーム済みで rules / skills の呼び出しは新名に統一。

- [x] T2.1: `src/mcp-tools/` ディレクトリを作成し domain ごとに 4 ファイル（`spec-tools.ts` / `state-tools.ts` / `detector-tools.ts` / `gate-tools.ts`）+ `index.ts` レジストリを設置。既存 16 tool の handler を該当ファイルへ移植し、内部実装を新 state モジュール（Wave 1 で追加分）に切り替え。SQLite 系モジュールへの依存は残してよい。
- [x] T2.2: 新規 5 tool（`get_active_spec`、`complete_wave`、`update_task_status`、`archive_spec`、`record_spec_evaluator_score`）を `spec-tools.ts` に追加。`complete_wave` は Range SHA reachability 検証と既完了拒否（`already_completed`）を実装。`update_task_status` は存在しない task_id で `task_not_found` を返す。
- [x] T2.3: `get_session_status` を `get_project_status` にリネームし `state-tools.ts` に集約。返却値に active_spec オブジェクトを統合（`get_active_spec` の結果を含める）。`archive_plan` を `archive_spec` にリネーム。古い tool 名は受け付けない（registry から削除）。
- [x] T2.4: 全 tool ハンドラの先頭で入力検証を呼ぶ共通関数（`spec_name` regex、`wave_num` 範囲、`realpath` 検証）を `src/mcp-tools/shared.ts` に実装。
- [x] T2.5: `src/mcp-server.ts` を再構成。`index.ts` を import して JSON-RPC dispatch のみを担当する形に縮小（〜200 行目標）。`SERVER_VERSION` 定数を `1.0.0` に更新。bun:sqlite 直接 import がここから消えていることを確認（state モジュール経由のみに）。
- [x] T2.6: 全 MCP tool の単体テストを更新・追加（fixture は temp ディレクトリベース）。新 5 tool の error semantics（`already_completed` / `task_not_found` / `sha_unreachable`）を網羅。
- [x] T2.7: `bun run build` で `plugin/dist/mcp-server.mjs` が生成され、SQLite 系モジュールがまだ存在することを確認しつつ、Wave 2 完了。

## Wave 3: SQLite removal

**Goal**: 旧 SQLite 系モジュールを削除し、bun:sqlite 依存をプロジェクトから完全に除去する。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。`grep -r "bun:sqlite" src/` が空。`src/state/db.ts`、`audit-log.ts`、`flush.ts`、`plan-status.ts`、`session-state.ts`、旧 `pending-fixes.ts`、旧 `src/config.ts` が削除されている。

- [x] T3.1: `src/state/db.ts`、`audit-log.ts`、`flush.ts`、`plan-status.ts`、`session-state.ts`、旧 `pending-fixes.ts` を削除。
- [x] T3.2: 旧 `src/config.ts` の DB 依存ロジックを `src/state/config.ts` に移管し、旧ファイルを削除。import 元（`src/mcp-server.ts` 等）を新パスに更新。
- [x] T3.3: `src/__tests__/` 配下の SQLite 依存テストを削除。新 state モジュールのテストでカバレッジが不足する箇所を補完。
- [x] T3.4: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass、`grep -r "bun:sqlite" src/` が空であることを確認、Wave 3 完了。

## Wave 4: Agents and spec lifecycle skills

**Goal**: spec 策定・実装フェーズの新 agent と skill を追加し、旧 plan-generator 系を削除する。
**Verify**: `bun run test` pass。新 skill（spec / clarify / wave-start / wave-complete / wip）が `plugin/skills/` に存在。新 agent（spec-generator / spec-clarifier / spec-evaluator）が `plugin/agents/` に存在し、旧 `plan-generator` / `plan-evaluator` agent ファイルおよび `/qult:plan-generator` skill ディレクトリは削除されている。

- [ ] T4.1: `plugin/agents/spec-generator.md` を作成。phase 引数（requirements / design / tasks）で生成対象を切替えるプロンプト。phase ごとに XML タグで区切り bleed を防ぐ。Wave 分割ルール 5 項目を厳守。
- [ ] T4.2: `plugin/agents/spec-clarifier.md` を作成。5-10 件の質問生成、選択肢 + 推奨形式、「お任せ」検知（日本語・英語パターン）+ 注記、スコープ大幅変更時の改名提案を含む。
- [ ] T4.3: `plugin/agents/spec-evaluator.md` を作成。phase 引数で評価基準切替（threshold 18/17/16、floor 4）。Completeness / Testability / Unambiguity / Feasibility 4 次元評価、temperature=0、threshold ± 1 retry、`forced_progress` フラグの伝播ロジックを含む。
- [ ] T4.4: 旧 `plugin/agents/plan-generator.md` と `plugin/agents/plan-evaluator.md` を削除。
- [ ] T4.5: `plugin/skills/spec/`、`plugin/skills/clarify/`、`plugin/skills/wave-start/`、`plugin/skills/wave-complete/`、`plugin/skills/wip/` を新規作成。`/qult:wave-complete` は (1) 過去 Wave Range SHA 検証 → (2) test（scaffold は skip）→ (3) detector → (4) commit msg 生成（git log / CLAUDE.md を untrusted-content fence で囲む）→ (5) ユーザー確認 → (6) commit → (7) `complete_wave` 呼び出しの順で実装し、各ステップ失敗時は中間状態を残し再実行可能にする。
- [ ] T4.6: 旧 `plugin/skills/plan-generator/` ディレクトリを削除。既存 reviewer agent（spec / quality / security / adversarial）の prompt 内 plan 言及を spec に置換。
- [ ] T4.7: `bun run test` で全 pass を確認、Wave 4 完了。

## Wave 5: Existing skill updates and workflow rules

**Goal**: 既存 9 skill を新フローに合わせて更新し、5 workflow rule を書き換える。
**Verify**: `bun run test` pass。`/qult:status archive` が機能。`/qult:init` が `.qult/` を生成し `.gitignore` を状態に応じて適切に更新（新規 / 既存 / 広い ignore ルール検出）。`plugin/rules/` に `qult-spec-mode.md` が存在し `qult-plan-mode.md` は削除されている。`/qult:review` skill 内および reviewer agent の plan 言及が完全に spec に置換されている。

- [ ] T5.1: `plugin/skills/init/` を更新。`.qult/specs/`、`.qult/state/`、`.qult/config.json` 生成、`.gitignore` への適切な更新（不在 → 新規作成、`.qult/state/` 既存 → no-op、広い `.qult/` ルール検出 → negation `!.qult/specs/` 追加 + 通知）、ホーム配下 `~/.qult/qult.db` の削除案内を含む。
- [ ] T5.2: `plugin/skills/status/` を更新。spec 情報統合、`/qult:status archive` で archive/ 配下一覧表示、ブランチ切り替え時の active spec 不一致警告。
- [ ] T5.3: `plugin/skills/finish/` を更新。spec 完了状態判定、`merge` / `pr` は review pass 必須、`discard` は無条件、archive 移動コミット作成（プロジェクトの commit message 規約は CLAUDE.md / git log から学習）。
- [ ] T5.4: `plugin/skills/doctor/` / `config/` / `skip/` / `update/` / `uninstall/` を新フローに合わせて更新。SQLite 言及を全削除、ファイルベース操作に置換。`/qult:doctor` は `.qult/state/*.json` が `git ls-files` に出現しないかチェック（誤って force-add された場合の警告）。
- [ ] T5.5: `plugin/rules/qult-plan-mode.md` を削除し、`plugin/rules/qult-spec-mode.md` を新規作成。EnterPlanMode は調査時のみ、実装は `/qult:spec` を使う旨と、Wave 中の振る舞い（branch 切替警告、commit prefix 規約）を記述。
- [ ] T5.6: `plugin/rules/qult-workflow.md`、`qult-pre-commit.md`、`qult-review.md`、`qult-quality.md` の plan 言及を spec / wave に書き換え。pre-commit に `[wave-NN]` prefix（2 桁ゼロパディング）と Wave 完了 detector の言及、review は spec 完了時のみ自動の旨を追加。
- [ ] T5.7: `plugin/skills/review/` の prompt を更新（spec 完了時のみ自動、Wave 中はユーザーが明示的に呼んだ場合のみ）。`bun run test` 全 pass を確認、Wave 5 完了。

## Wave 6: Documentation, version bump, integration verification

**Goal**: CLAUDE.md・plugin manifest を v1.0 に更新し、sdd-rewrite spec 自身をドッグフードして e2e 動作確認する。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。CLAUDE.md / plugin.json / marketplace.json が `1.0.0`。`/qult:status` が active spec=sdd-rewrite を返し、`/qult:status archive` でアーカイブ後に sdd-rewrite が表示される。

- [ ] T6.1: `CLAUDE.md`（プロジェクトルート）を更新。Rules（5 ファイル名変更）、MCP server tool 一覧（20 tool、domain グルーピング）、Reviewer モデル表（spec-evaluator）、TDD（spec の `Verify:` フィールド）、Out of Scope（worktree 並列、O_NOFOLLOW 等）の各セクションを書き換え。
- [ ] T6.2: `plugin/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` のバージョンを `1.0.0` に bump。description / changelog があれば更新。
- [ ] T6.3: 統合テスト（temp プロジェクトで `/qult:init` → `/qult:spec` → mock clarify 回答 → wave-start → wave-complete × 1 → finish）の e2e テストを追加（CI 自動実行可能な範囲）。本タスクの Verify は CI で完結し、T6.4 の対話ステップとは分離する。
- [ ] T6.4: 自身（sdd-rewrite spec）の全 Wave 完了後、`/qult:review` で 4-stage review を**手動実施**（このステップは CI ゲートではなく architect の最終受入確認）。pass を確認し、`/qult:finish` で archive 移動、`bun run build` で成果物が安定して生成されることを最終確認、Wave 6 完了。
