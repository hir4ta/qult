# Requirements: sdd-rewrite

## Overview

qult v1.0 として、現行の Claude Code 標準 plan mode に依存した plan-generator フローを完全廃止し、**Spec-Driven Development (SDD) モード**へリプレイスする。`/qult:spec` を起点に requirements / design / tasks の三点セット markdown を物理生成し、Spec → Wave → Task の階層構造下で実装を進め、各 Wave をコミット範囲と紐付ける。状態は SQLite を撤廃しプロジェクト内 `.qult/` 配下のファイルで管理する。

設計の出発点は GitHub Spec Kit の構造化フロー、tsumiki の AITDD 思想、qult 既存の独立レビューと評価ゲートを統合したもの。後方互換性は持たず、既存ユーザー（現状単独）に対して clean break を行う。

## User Stories

- As an architect, I want SDD ワークフローで要件と設計を構造化したい、so that 実装前に曖昧さが排除され、レビュアーがコミットからフィーチャー全体を理解できる。
- As an architect, I want clarify フェーズで AI から要件の曖昧点を質問されたい、so that 暗黙の仮定が言語化され、後工程の手戻りを減らせる。
- As an architect, I want 1 Wave = 1 コミット範囲で実装を進めたい、so that レビュアーがコミット履歴と Wave 仕様を 1:1 で対応付けて読める。
- As an architect, I want spec ドキュメントが git に commit される、so that フィーチャーの仕様と実装が同じリポジトリで同じ履歴に乗る。
- As an architect, I want trivial change で SDD を強制されない、so that typo 修正等で余計な摩擦を受けない。
- As a reviewer, I want spec 完了時にまとめて 4-stage review を受けたい、so that 全 Wave 通したフィーチャー全体の整合性を一度に評価できる。
- As an architect, I want 評価ゲート fail 時に修正用 Wave を追加できる、so that 履歴を rebase で書き換えることなく前進的に修正できる。

## Acceptance Criteria

### Spec ライフサイクル

- WHEN ユーザーが `/qult:spec <name> "<description>"` を実行したとき、システムは `.qult/specs/<name>/` ディレクトリを作成し requirements.md draft を生成する
- WHEN spec 開始時点で非 archive な spec が既に `.qult/specs/` に存在するとき、システムはエラーを返し新 spec の作成を拒否する
- WHEN requirements.md draft 生成が完了したとき、システムは clarify フェーズに自動遷移する
- WHILE clarify フェーズ中、システムは 1 ラウンドあたり 5 件以上 10 件以下の質問を生成する
- WHEN ユーザーが clarify 質問に回答したとき、システムは requirements.md の Open Questions セクションを更新する
- IF clarify を 3 ラウンド実施しても Open Questions が残る場合、システムはユーザーに「強制進行 / 中断 / 追加ラウンド」の選択を求める
- WHEN ユーザーが clarify 質問に「お任せ」相当の回答をしたとき、システムは推奨選択肢を採用し当該項目に「(AI 推奨により採用)」と注記する
- WHEN clarify 完了後、システムは spec-evaluator を起動し requirements を採点する
- IF requirements の総合スコアが 18/20 未満、または任意の次元スコアが 4/5 未満の場合、システムは clarify フェーズに戻り追加質問を生成する
- WHEN requirements 評価が pass したとき、システムは design.md を生成する
- IF design の総合スコアが 17/20 未満、または任意の次元スコアが 4/5 未満の場合、システムは design.md を再生成する
- WHEN design 評価が pass したとき、システムは tasks.md を Wave 分割付きで生成する
- IF tasks の総合スコアが 16/20 未満、または任意の次元スコアが 4/5 未満の場合、システムは tasks.md を再生成する
- WHEN 各評価ゲートで再生成上限（3 回）を超えたとき、システムはユーザーに「強制進行 / 中断」の選択を求める
- WHEN 評価ゲートで強制進行が選択されたとき、システムは当該 phase の `forced_progress: true` フラグを stage-scores.json に記録し、後続 phase の評価入力に含める
- WHEN spec-evaluator を起動するとき、システムは temperature=0 を指定し、スコアが threshold 直近（threshold ± 1）の場合のみ 1 回 retry してスコアを安定化する
- WHEN 新規 spec の作成が確定したとき、システムは stage-scores.json の spec_eval ブロックを初期化し、過去 spec のスコア漏洩を防ぐ

### Wave 実装

- WHEN ユーザーが `/qult:wave-start` を実行したとき、システムは `git rev-parse HEAD` の値を Wave の start commit として `waves/wave-NN.md` に記録する
- WHILE Wave ファイル名およびコミット prefix を生成するとき、システムは Wave 番号を常に 2 桁ゼロパディング（`wave-01`、`[wave-01]`）で表記し、上限を 99 とする
- WHEN 実装中に task が完了したとき、システムは `update_task_status` MCP ツール経由で tasks.md と wave-NN.md のチェックボックスを更新する
- IF `update_task_status` の対象 task_id が tasks.md に存在しない場合、システムは `{ ok: false, reason: "task_not_found" }` を返し silent no-op を行わない
- IF `complete_wave` が同一 wave_num に対し既に完了記録がある状態で再実行された場合、システムは上書きを拒否し `{ ok: false, reason: "already_completed" }` を返す
- WHEN ユーザーが `/qult:wip` を実行したとき、システムは `[wave-NN] wip: <message>` 形式の prefix を付与してコミットを作成する
- WHEN ユーザーが `/qult:wave-complete` を実行したとき、システムはテストコマンドを実行する
- IF 当該 Wave のメタデータに `scaffold: true` が設定され、かつテストファイルがプロジェクトに 0 件の場合、システムはテスト実行を skip し `bun run build` の成功のみを完了条件とする
- IF `/qult:wave-complete` 実行時にテストが fail したとき、システムは Wave 完了処理を中断する
- WHEN テストが pass したとき、システムは Tier 1 detector 群を実行する
- IF detector 結果に severity=high の finding が含まれる場合、システムは Wave 完了処理をブロックしユーザーに修正を促す
- WHEN detector 結果が問題なしまたは severity=high なしのとき、システムはコミットメッセージを生成しユーザー確認を経てコミットを作成する
- WHEN コミット作成後、システムは wave-NN.md に commit range と completed_at を記録する
- WHILE Wave 内のコミットを作成するとき、システムはコミットメッセージに `[wave-NN]` prefix を付与する
- WHEN `/qult:wave-complete` を実行するとき、システムは過去 Wave に記録された `Range` の start_sha と end_sha が `git rev-parse --verify <sha>^{commit}` で reachable であることを検証する
- IF 過去 Wave の Range SHA が unreachable な場合（rebase / reset --soft / force-push 後など）、システムは現 Wave の完了を中断し、ユーザーに「Range の再記録 / Wave 中断」の選択を求める
- WHEN 修正専用 Wave（review-fix Wave）を tasks.md に追加するとき、システムは wave-NN.md に `Fixes: wave-MM` メタデータを記録し、対象 Wave の wave-MM.md に `Superseded by: wave-NN` を追記する

### Spec 完了とレビュー

- WHEN 全 Wave が完了したとき、システムは spec 完了状態として認識する
- WHEN spec 完了状態でユーザーが `/qult:review` を実行したとき、システムは spec 全体の変更に対し 4-stage 独立レビューを実行する
- IF 4-stage review が fail し修正が必要なとき、システムは修正専用 Wave を tasks.md に追加する
- WHEN ユーザーが `/qult:finish` を merge / PR 意図で実行したとき、システムは review pass を必須条件として確認する
- IF Wave 未完了または review 未完了のとき、システムは `/qult:finish` の merge / PR 操作を拒否し、discard 操作のみ許可する
- WHEN `/qult:finish` の archive 処理が走るとき、システムは `.qult/specs/<name>/` を `.qult/specs/archive/<name>/` に移動するコミットを作成する
- IF archive 移動先 `.qult/specs/archive/<name>/` が既に存在する場合、システムは `<name>-<YYYYMMDD-HHMMSS>` のタイムスタンプ suffix を付与して衝突を回避する

### Branch とコミット規約

- WHILE active spec が存在するとき、システムは spec とブランチ名を紐付けず、1 リポジトリ状態あたり 1 spec のみを許可する
- IF ユーザーが main / master ブランチで `/qult:spec` を実行したとき、システムは作成を拒否せず通常通り spec を生成する
- WHILE Wave 実装中、システムはユーザーが任意のタイミングで複数コミットを作成することを許容する
- WHEN Wave 完了時、システムは Wave に属するコミット群を range（start_sha..end_sha）として wave-NN.md に記録する
- IF Wave 実装中にユーザーが `git checkout` で別ブランチに切り替えたとき、Claude は `/qult:status` 等で active spec の不一致を検知して警告を表示する

### Trivial change と EnterPlanMode

- WHEN active spec が存在しない状態で git commit が行われるとき、システムは spec 化を強制しない
- IF 直近の変更ファイル数が 5 を超え active spec が無い場合、Claude は spec 化の検討をユーザーに提案する
- WHEN ユーザーがコード変更を伴わない調査タスクを実行するとき、システムは EnterPlanMode の利用を許容する
- IF コード変更を伴うタスクで EnterPlanMode が起動されようとした場合、qult-spec-mode rule は `/qult:spec` への切り替えを促す

### Detector とゲート

- WHEN `/qult:wave-complete` が実行されたとき、システムは Tier 1 detector 群を起動する
- WHEN spec 完了 review 時、システムは get_detector_summary を呼び reviewer に detector 結果を文脈として渡す
- IF detector finding の severity が high のとき、システムは Wave commit を block する
- IF detector finding の severity が medium 以下のとき、システムは警告のみ表示しコミット続行を許可する

### State と config

- WHILE qult が動作中、システムはプロジェクトルート `.qult/` 配下のファイルのみを永続状態として参照する
- WHILE qult が動作中、システムは `~/.qult/` グローバル状態およびホーム配下の SQLite データベースを一切参照しない
- WHEN `/qult:init` が実行されたとき、システムは `.qult/specs/`、`.qult/state/`、`.qult/config.json` を生成し、`.qult/state/` を `.gitignore` に追加する
- WHILE `/qult:init` が `.gitignore` を更新するとき、システムは既存の `.qult/` または `.qult` などの広いルールが `.qult/specs/` を ignore していないか検査し、衝突がある場合は `!.qult/specs/` 等の negation を追加してユーザーに通知する
- IF `.gitignore` が存在しない場合、システムは新規作成して `.qult/state/` を記載する
- WHILE qult が動作中、システムは MCP tool 入力の `spec_name` を `^[a-z0-9][a-z0-9-]{0,63}$` で検証し、`archive` 等の予約名および `/`、`\`、`.` を含む値を拒否する
- WHILE qult がファイル I/O を行うとき、システムは対象パスの `realpath` を解決し、`.qult/` 配下に閉じていない場合は操作を拒否する
- WHEN ユーザーが `/qult:status archive` を実行したとき、システムは `.qult/specs/archive/` 配下の過去 spec 一覧を表示する

## Out of Scope

- マルチツール対応（Cursor / Gemini CLI / Copilot 等）。v1.0 では Claude Code 専用とする。将来の v2.0 検討。
- 複数 active spec の並列実行。1 リポジトリ状態あたり 1 spec のみ。
- **複数 worktree からの並行 qult 操作**。同一プロジェクトの複数 worktree が同時に `.qult/specs/` を編集する場合の整合性は保証しない（last-write-wins）。並行作業が必要な場合はブランチ単位ではなく **clone 単位**で分離すること。
- Wave 単位の自動レビュー起動。review は spec 完了時のみ自動、Wave 中の review はユーザーが手動で `/qult:review` を呼ぶ場合のみ。
- 既存 SQLite データのマイグレーション。clean break で既存 `~/.qult/qult.db` は単純削除。
- 後方互換性。`plan-*` 命名・`get_session_status` 等の旧 MCP tool は削除（リネーム）し、deprecated 警告期間を設けない。
- Constitutional principles ファイル（Spec Kit 由来）。プロジェクトの CLAUDE.md で代替する。
- Wave 中のコミット履歴の squash / rebase 機能。range binding 採用のため履歴は前進のみ。
- 信号色（🟢🟡🔴）による曖昧度マーカー。Open Questions セクションで集約する方式に統一。
- prepare-commit-msg などの git hook 自動生成。`/qult:wip` skill のみで prefix を付与。
- spec ドキュメントの非 markdown 形式（YAML / JSON / TOML 等）。markdown のみをサポート。
- 高度な path 攻撃対策（`O_NOFOLLOW`、ファイル所有者検証、cap-and-swap version counter 等）。`realpath` による `.qult/` 配下チェックと spec_name の文字検証で個人開発スコープに見合う最低限の防御を提供する。
- detector severity 値の暗号的検証 / 署名 rule set。ユーザーが導入した detector rule の信頼性は qult のスコープ外。
- mixed-version 環境（同ホストで異なる qult バージョンが共存）の workflow rules 互換性保証。`/qult:update` は常に最新版で上書きする。
- ロックファイル / 生成物を除外した変更ファイル数カウント。trivial change の 5 ファイル警告は素朴な diff 件数で算出する。

## Open Questions

（議論段階で全て解決済み。実装フェーズで新たな曖昧点が発見された場合は本セクションに追記し再 clarify を実施する）

- [closed] Q1: spec とブランチ名の紐付け → 完全 decouple、1 リポジトリ状態 = 1 spec
- [closed] Q2: main-direct workflow のサポート → サポートする
- [closed] Q3: Wave とコミットの binding 強度 → range（複数コミット可）+ `[wave-NN]` prefix
- [closed] Q4: 曖昧度マーカー → 絵文字を使わず Open Questions セクションで集約
- [closed] Q5: spec-evaluator の数 → 単一 agent で phase 引数により基準切替
- [closed] Q6: 評価ゲート threshold → requirements 18 / design 17 / tasks 16（floor 4）
- [closed] Q7: review の起動タイミング → spec 完了時のみ自動
- [closed] Q8: review fail 時の修正単位 → 修正専用 Wave を追加（履歴前進のみ）
- [closed] Q9: trivial change の扱い → fail-open、5 ファイル超で警告のみ
- [closed] Q10: EnterPlanMode の disposition → 調査時のみ許容、実装時は禁止
- [closed] Q11: archive コミットメッセージ → プロジェクト規約に従う（Claude が CLAUDE.md / git log から学習）
- [closed] Q12: SQLite と global config → 完全廃止、`.qult/` ファイルのみ
- [closed] Q13: Wave 番号の桁数規約 → 常に 2 桁ゼロパディング、上限 99
- [closed] Q14: scaffold Wave のテスト例外 → wave メタデータ `scaffold: true` 時は test を skip し build 成功のみ要求
- [closed] Q15: complete_wave / update_task_status の error semantics → silent no-op 禁止、明示的なエラー reason を返す
- [closed] Q16: Range SHA reachability → 各 wave-complete 前に検証、unreachable 時は再記録 or 中断を求める
- [closed] Q17: review-fix Wave の supersedes 関係 → wave-NN.md に Fixes / Superseded by を相互記録
- [closed] Q18: stage-scores.json の spec 跨ぎ漏洩 → 新 spec 確定時に spec_eval ブロック初期化
- [closed] Q19: archive 名衝突 → タイムスタンプ suffix で回避
- [closed] Q20: spec_name 検証 → kebab-case allowlist `^[a-z0-9][a-z0-9-]{0,63}$`、予約名 `archive` 拒否
- [closed] Q21: path safety → `realpath` で `.qult/` 配下に閉じることを検証、O_NOFOLLOW 等は out-of-scope
- [closed] Q22: LLM scoring 安定性 → temperature=0、threshold ± 1 のみ 1 回 retry
- [closed] Q23: worktree 並列 → out-of-scope、clone 単位分離を推奨
- [closed] Q24: 強制進行フラグの伝播 → `forced_progress` フラグを stage-scores.json に記録、後続 phase の入力に含める
- [closed] Q25: prompt-injection（commit msg 生成時の git log / CLAUDE.md） → untrusted-content fence で囲む
