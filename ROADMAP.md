# alfred ロードマップ

## v0.1.0 (完了)

13 Hooks + Skill + Agent の最小完成系。

- 壁: PostToolUse (lint/type gate) → PreToolUse (DENY)
- Plan増幅: UserPromptSubmit (template + status tag) + PermissionRequest (ExitPlanMode検証) + TaskCompleted (status自動同期)
- 実行ループ: Stop (Plan未完了block + pending-fixes block) + PreCompact/SessionEnd (handoff)
- サブエージェント制御: SubagentStart (品質ルール注入) + SubagentStop
- 防御: PostToolUseFailure (失敗追跡) + ConfigChange (hook削除防止)
- init: 13 hooks + skill + agent + rules + gates 一括配置
- 83テスト, 22シミュレーションシナリオ

---

## v0.2.0 — dogfooding + 品質基盤強化

v0.1 を alfred 自身で使って実装する。hook の実動作を確認しながら修正。

### 2.1 doctor コマンド (完了)

`alfred doctor` でセットアップの健全性を一目で確認。8項目チェック実装済み。
17テスト + Scenario 23 (init→doctor 統合)。

### 2.2 run_once_per_batch

**問題:** tsc が毎 Edit ごとに走る (10s x N回)。`run_once_per_batch: true` フラグは gates.json に定義済みだが未実装。

**設計:**
- `.alfred/.state/gate-batch.json`: `{ "typecheck": { "session_id": "abc", "ran_at": "ISO" } }`
- PostToolUse で gate 実行前に batch state を確認
- 同一 session_id で実行済みなら skip
- git commit 時 / session 変更時にリセット

**影響ファイル:**
- `src/hooks/post-tool.ts` — gate ループに batch チェック追加
- `src/state/gate-batch.ts` — 新規

### 2.3 SubagentStop 検証強化

**問題:** サブエージェントの出力品質を検証していない。

**設計:**
- `last_assistant_message` から最終出力を取得
- Plan subagent → `## Tasks` + `## Review Gates` 必須
- Review subagent → `[severity] file:line` 形式の findings 必須
- 不合格 → `decision: "block"` で差し戻し
- `agent_type` フィールドで判定 (Plan / alfred-reviewer 等)

**影響ファイル:** `src/hooks/subagent-stop.ts`

### 2.4 dogfooding 修正 (一部完了)

v0.2 実装中に発見された問題:
- **修正済み**: Bun グローバル依存 (`Bun.spawnSync`, `Bun.file`) → vitest fork で利用不可。Node の `execSync`/`statSync` に置換。9テスト修正。
- **修正済み**: `alfred init` で 7/13 hooks しか登録されていなかった → init 再実行で解消。
- ConfigChange の過剰 DENY (project_settings 変更まで巻き込む等)
- gate タイムアウト (tsc が 10s で終わらないプロジェクト)
- Plan テンプレートの遵守率が低い (長すぎてClaudeが省略)
- pending-fixes のパスマッチング (絶対パス vs 相対パスの不一致)
- SubagentStart の注入コンテキストが重すぎる

---

## v0.3.0 — Plan-Execution 整合性の強化

v0.2 で dogfooding した結果を基に、設計↔実装の乖離を防ぐ仕組みを強化。

### 3.1 PostToolUse: テスト検証の自動化

**問題:** Plan の Verify フィールド (`src/__tests__/foo.test.ts:barFunction`) が書かれているが、実際にそのテストが通ったかは検証されていない。

**設計:**
- PostToolUse で Bash (test コマンド) 完了後、Plan の Verify フィールドを読む
- テスト出力に指定された関数名が含まれ、pass しているか確認
- fail していれば additionalContext で「Plan の Task N の検証テストが失敗しています」
- pass していれば Plan の該当タスクを自動的に [done] に更新 (TaskCompleted 経由ではなくテスト結果ベース)

**リサーチ根拠:** TDAD 論文「HOWではなくWHATを伝える。どのテストを確認すべきかを提供すると regression -70%」

**影響ファイル:**
- `src/hooks/post-tool.ts` — handleBash にテスト結果パーサー追加
- `src/state/plan-status.ts` — `updateTaskByVerify()` 関数追加

### 3.2 PostToolUse: Bash exit code の直接検出

**問題:** 現在 Bash エラーは `tool_output` の文字列マッチで検出。不安定。

**設計:**
- Claude Code の PostToolUse 入力に `exit_code` フィールドがあるか調査 (v0.2 dogfooding で確認)
- あれば直接使う。なければ `tool_output` から regex で抽出 (現行方式を維持)

### 3.3 PermissionRequest: Plan 構造の詳細検証

**問題:** 現在は「Review」という単語が含まれるかだけチェック。Plan の各 Task に必須フィールド (File, Change, Verify, Boundary, [status]) が揃っているかは未検証。

**設計:**
- ExitPlanMode 時に Plan ファイルを parsePlanTasks でパース
- 各タスクに `File:`, `Verify:`, `[pending]` が含まれているか検証
- 不足していれば DENY + 具体的な不足フィールドを指摘

**影響ファイル:**
- `src/hooks/permission-request.ts` — 構造検証追加
- `src/state/plan-status.ts` — フィールド解析追加

### 3.4 PostCompact hook

**問題:** PreCompact でハンドオフを保存するが、PostCompact で復元コンテキストを注入する方がタイミングが正確。現在は SessionStart の compact matcher で代替しているが、PostCompact は「コンパクション直後」に発火するため、より適切。

**設計:**
- PostCompact hook handler を追加
- handoff.json を読んで additionalContext で注入
- SessionStart のハンドオフ復元と役割分担: PostCompact = コンパクション後の復元, SessionStart = セッション再開時の復元

**影響ファイル:**
- `src/hooks/post-compact.ts` — 新規
- `src/hooks/dispatcher.ts` — 登録追加
- `src/init.ts` — hook 登録追加

---

## v0.4.0 — コンテキスト最適化

リサーチが示す「コンテキストの質」を最大化する。

### 4.1 コンテキスト予算管理

**問題:** additionalContext を注入しすぎると逆効果 (Chroma Research: 集中300tokが113Kに圧勝)。現在は各hookが独立して注入しており、総量を管理していない。

**設計:**
- `.alfred/.state/context-budget.json`: `{ "session_id": "abc", "injected_tokens": 0, "budget": 2000 }`
- 各hookの respond() 呼び出し前に予算チェック
- 予算超過なら注入をスキップ (fail-open: 注入しないだけで動作は止めない)
- 予算は session ごとにリセット
- 優先度: DENY/block (常に発火) > 壁の additionalContext > Plan の additionalContext > サブエージェントの additionalContext

**リサーチ根拠:**
- Chroma: 集中プロンプト(300tok) が 113K tok に圧勝
- TDAD: スキル定義 107行→20行で解決率4倍
- HumanLayer: CLAUDE.md は 60行以下が最適

**影響ファイル:**
- `src/state/context-budget.ts` — 新規
- `src/hooks/respond.ts` — respond() に予算チェック追加

### 4.2 Plan テンプレートの動的調整

**問題:** 全てのタスクに同じテンプレートを注入するのは非効率。小さなタスクにフルテンプレートは過剰。

**設計:**
- プロンプトの長さ/複雑さに応じてテンプレートのレベルを変える
  - Short (< 100 chars): テンプレートなし
  - Medium (100-300 chars): 簡易テンプレート (Context + Tasks のみ)
  - Large (300+ chars): フルテンプレート (Review Gates 含む)

### 4.3 additionalContext の位置最適化

**問題:** Lost in the Middle (Liu et al.): 中間の情報は失われる。additionalContext がコンテキストのどこに挿入されるかは Claude Code の実装依存。

**調査項目:**
- additionalContext は system message の先頭/末尾のどちらに挿入されるか
- 複数 hook の additionalContext はどの順序で並ぶか
- 重要な情報を先頭に置く方法はあるか

**この調査結果に基づいて注入戦略を最適化する。**

---

## v0.5.0 — 学習と適応

alfred がプロジェクトに適応する。

### 5.1 gate 結果のトレンド分析

**問題:** 同じ lint エラーが毎回出る場合、additionalContext で「このプロジェクトで頻出するエラー」を注入すれば Claudeが事前に避けられる。

**設計:**
- `.alfred/.state/gate-history.json`: 直近N回の gate 結果を保存
- SessionStart で頻出エラーパターンを additionalContext に注入
- 例: 「このプロジェクトでは unused import エラーが最も多い。import 追加時に注意」

### 5.2 Pace パラメータの適応的調整

**問題:** 35分/5ファイルの閾値は固定。プロジェクトによって適切な値は異なる。

**設計:**
- gate-history からコミット間隔の平均を計算
- 平均の 1.5x を yellow, 2x を red に動的設定
- ファイル数閾値も同様に適応

### 5.3 テスト結果からの自動 convention 生成

**問題:** テストで頻繁に失敗するパターンがあれば、それを convention として rules に追加すべき。

**設計:**
- gate-history のエラーパターンを分析
- 3回以上同じカテゴリのエラーが出たら、自動的に rules ファイルに追記
- 例: 「biome: noUnusedImports が 5回検出 → ルール追加: import 追加時に使用箇所を確認」

---

## v1.0.0 — 知識復活 (必要になったら)

v0.x で十分な dogfooding データが溜まったら、v1.x で削除した知識DB を必要に応じて復活。

### 1.1 error_resolution キャッシュ

**条件:** dogfooding で「同じエラーに何度も遭遇し、毎回調べ直している」パターンが観測されたら。

**設計:**
- SQLite (bun:sqlite) で軽量DB。Voyage AI は使わない (検索は SQLite FTS5)
- PostToolUse で Bash エラー → 成功ペアを自動検出して保存
- PostToolUseFailure でエラーメッセージを FTS5 検索 → ヒットしたら additionalContext に注入

### 1.2 fix_pattern キャッシュ

**条件:** 「同じ lint/type 修正パターンを毎回 Claude が試行錯誤している」パターンが観測されたら。

**設計:**
- PostToolUse で gate fail → pass サイクルの before/after diff を保存
- 同じ gate 失敗時に過去の fix パターンを additionalContext に注入

### 1.3 decision 蓄積

**条件:** 「設計上の意思決定を毎セッション繰り返し説明している」パターンが観測されたら。

**設計:**
- Plan ファイルの ## Context セクションを自動保存
- 類似の Plan 作成時に過去の Context を参考として注入

---

## 未定 (アイデアプール)

### FileChanged hook でリアルタイム gates.json リロード
- `.alfred/gates.json` が手動編集されたら自動リロード
- `package.json` が変更されたら gate 再検出

### WorktreeCreate hook で worktree 用 gates 初期化
- サブエージェントが worktree で作業する場合、`.alfred/` を worktree にもコピー

### Notification hook で Slack/Discord 連携
- gate fail / Plan 未完了 / Pace red 等をリアルタイム通知
- 複数マシンでの並行作業時に状態共有

### prompt hook type でのレビュー
- Stop hook を `type: "agent"` にして、LLM ベースの出力品質検証
- 現在の command hook では機械的チェックのみ。LLM 評価は agent hook で実現
- コスト: 毎 Stop で Haiku 1回 ≈ $0.001。1セッション100回停止で $0.1

### uninstall コマンド
- `alfred uninstall` で settings.json からhook削除、skill/agent/rules 削除、.alfred/ 削除
