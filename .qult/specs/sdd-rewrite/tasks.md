# Tasks: sdd-rewrite

## Wave 1: Filesystem foundation

**Goal**: SQLite を撤廃せず、.qult/ ファイルベースの新 state モジュール群を追加する。既存実装と共存し、ビルド・全テストが pass する状態を維持する。
**Verify**: `bun run typecheck && bun run lint && bun run test` が pass。新規モジュールの単体テスト（atomic write、markdown parser round-trip、paths 算出）が pass。

- [ ] T1.1: `src/state/paths.ts` を新規作成。cwd ベースで `.qult/specs/<name>/{requirements,design,tasks}.md`、`waves/wave-NN.md`、`state/{current,pending-fixes,stage-scores}.json`、`config.json` の絶対パス算出関数群を export。
- [ ] T1.2: `src/state/fs.ts` を新規作成。atomic write（`<file>.tmp` → `rename`）、JSON read/write（schema_version 検証含む）、ファイル存在確認、ディレクトリ自動作成のユーティリティを実装。
- [ ] T1.3: `src/state/tasks-md.ts` を新規作成。tasks.md / wave-NN.md の parser と writer。Wave セクション分割、task 行の status 更新、commit range 追記。parse 失敗時は例外を投げ元ファイルを破壊しない。
- [ ] T1.4: `src/state/spec.ts` を新規作成。active spec の判定（`.qult/specs/` 走査、archive/ 除外）、archive 移動、wave-NN.md 生成・更新、spec phase 推定。
- [ ] T1.5: `src/state/current.ts` / `src/state/pending-fixes.ts`（新版）/ `src/state/stage-scores.ts` を新規作成。各 JSON ファイルの read/write を担当。
- [ ] T1.6: 上記 5 モジュールに対する単体テストを `src/__tests__/` 配下に追加。markdown parser は round-trip（parse → 状態変更 → write → re-parse で同等）、atomic write は中断時の整合性を検証。
- [ ] T1.7: `bun run typecheck && bun run lint && bun run test` が全 pass することを確認し、Wave 1 完了。

## Wave 2: MCP tool rebuild on filesystem

**Goal**: MCP server を新 state モジュール群に切り替え、新規 5 tool を追加、SQLite 依存実装を削除する。Wave 完了時点で全テスト pass、`bun run build` 成功。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` が pass。新 MCP tool（`get_active_spec`、`complete_wave`、`update_task_status`、`archive_spec`、`record_spec_evaluator_score`）の単体テストが pass。bun:sqlite import が src/ 配下にゼロ。

- [ ] T2.1: `src/mcp-tools/` ディレクトリを作成し、tool 1 個 1 ファイルの構造で既存 16 tool を移植。`src/mcp-tools/index.ts` で registry を export。
- [ ] T2.2: 新規 5 tool（`get_active_spec`、`complete_wave`、`update_task_status`、`archive_spec`、`record_spec_evaluator_score`）を `src/mcp-tools/` に追加。各 handler は新 state モジュールのみ使用。
- [ ] T2.3: `get_session_status` を `get_project_status` にリネーム。返却値に active_spec オブジェクトを統合。古い tool 名は受け付けない。
- [ ] T2.4: 旧 SQLite 依存ファイル（`src/state/db.ts`、`audit-log.ts`、`flush.ts`、`plan-status.ts`、`session-state.ts`、旧 `pending-fixes.ts`）を削除。`src/config.ts` の DB 参照箇所も file-based に置換。
- [ ] T2.5: `src/mcp-server.ts` を再構成。registry を import して JSON-RPC dispatch のみを担当する形に縮小。bun:sqlite import 削除。
- [ ] T2.6: 全 MCP tool の単体テストを更新・追加。fixture は temp ディレクトリベース。
- [ ] T2.7: `bun run build` で `plugin/dist/mcp-server.mjs` が生成され、`grep -r "bun:sqlite" src/` が空であることを確認し、Wave 2 完了。

## Wave 3: Agents and spec lifecycle skills

**Goal**: spec 策定・実装フェーズの新 agent と skill を追加し、旧 plan-generator 系を削除する。
**Verify**: `bun run test` pass。新 skill ディレクトリ（spec / clarify / wave-start / wave-complete / wip）が `plugin/skills/` に存在。新 agent（spec-generator / spec-clarifier / spec-evaluator）が `plugin/agents/` に存在し、旧 plan-generator / plan-evaluator は削除されている。

- [ ] T3.1: `plugin/agents/spec-generator.md` を作成。phase 引数（requirements / design / tasks）で生成対象を切替えるプロンプト。Wave 分割ルール 5 項目を厳守。
- [ ] T3.2: `plugin/agents/spec-clarifier.md` を作成。5-10 件の質問生成、選択肢 + 推奨形式、「お任せ」検知 + 注記、スコープ大幅変更時の改名提案を含む。
- [ ] T3.3: `plugin/agents/spec-evaluator.md` を作成。phase 引数で評価基準切替（threshold 18/17/16、floor 4）。Completeness / Testability / Unambiguity / Feasibility 4 次元評価。
- [ ] T3.4: 旧 `plugin/agents/plan-generator.md` と `plugin/agents/plan-evaluator.md` を削除。
- [ ] T3.5: `plugin/skills/spec/` `plugin/skills/clarify/` `plugin/skills/wave-start/` `plugin/skills/wave-complete/` `plugin/skills/wip/` を新規作成。各 SKILL.md は orchestration を記述、副作用は MCP tool 呼び出しに集約。
- [ ] T3.6: 旧 `plugin/skills/plan-generator/` ディレクトリを削除。
- [ ] T3.7: 既存 reviewer agent（spec / quality / security / adversarial）の prompt 内 plan 言及を spec に置換し、`bun run test` で全 pass を確認、Wave 3 完了。

## Wave 4: Existing skill updates and workflow rules

**Goal**: 既存 9 skill を新フローに合わせて更新し、5 workflow rule を書き換える。
**Verify**: `bun run test` pass。`/qult:status archive` が機能する。`/qult:init` が `.qult/` を生成し `.gitignore` を更新する。`plugin/rules/` に `qult-spec-mode.md` が存在し `qult-plan-mode.md` は削除されている。

- [ ] T4.1: `plugin/skills/init/` を更新。`.qult/specs/`、`.qult/state/`、`.qult/config.json` 生成、`.gitignore` への `.qult/state/` 追加、ホーム配下 `~/.qult/qult.db` の削除案内を含む。
- [ ] T4.2: `plugin/skills/status/` を更新。spec 情報統合、`/qult:status archive` で archive/ 配下一覧表示の subcommand 対応。
- [ ] T4.3: `plugin/skills/finish/` を更新。spec 完了状態判定、`merge` / `pr` は review pass 必須、`discard` は無条件、archive 移動コミット作成。
- [ ] T4.4: `plugin/skills/doctor/` `plugin/skills/config/` `plugin/skills/skip/` `plugin/skills/update/` `plugin/skills/uninstall/` を新フローに合わせて更新。SQLite 言及を全削除、ファイルベース操作に置換。
- [ ] T4.5: `plugin/rules/qult-plan-mode.md` を削除し、`plugin/rules/qult-spec-mode.md` を新規作成。EnterPlanMode は調査時のみ、実装は `/qult:spec` を使う旨を記述。
- [ ] T4.6: `plugin/rules/qult-workflow.md`、`qult-pre-commit.md`、`qult-review.md`、`qult-quality.md` の plan 言及を spec / wave に書き換え。pre-commit に `[wave-NN]` prefix と Wave 完了 detector の言及を追加。
- [ ] T4.7: `plugin/skills/review/` の prompt を更新（spec 完了時のみ自動、Wave 中は手動可）。`bun run test` 全 pass を確認し、Wave 4 完了。

## Wave 5: Documentation, version bump, integration verification

**Goal**: CLAUDE.md・README・plugin manifest を v1.0 に更新し、sdd-rewrite spec 自身をドッグフードして e2e 動作確認する。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。CLAUDE.md / plugin.json / marketplace.json が v1.0.0。`/qult:status` が active spec=sdd-rewrite を返し、`/qult:status archive` でアーカイブ後に sdd-rewrite が表示される。

- [ ] T5.1: `CLAUDE.md`（プロジェクトルート）を更新。Rules（5 ファイル名変更）、MCP server tool 一覧、Reviewer モデル表（spec-evaluator）、TDD（spec の Verify: フィールド）の各セクションを書き換え。
- [ ] T5.2: `plugin/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` のバージョンを `1.0.0` に bump。description / changelog があれば更新。
- [ ] T5.3: 統合テスト（temp プロジェクトで `/qult:init` → `/qult:spec` → mock clarify 回答 → wave-start → wave-complete × 1 → finish）の e2e テストを追加。
- [ ] T5.4: 自身（sdd-rewrite spec）の全 Wave 完了後、`/qult:review` で 4-stage review 実施。pass を確認し、`/qult:finish` で archive 移動、`bun run build` で成果物が安定して生成されることを最終確認、Wave 5 完了。
