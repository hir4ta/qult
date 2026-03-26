# claude-alfred

Claude Code の性能を倍増させる執事。14 Hooks + Skill + Agent。

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)

## アーキテクチャ

```
alfred CLI (init / hook / doctor)
    ├── alfred init → ~/.claude/ に 14 hooks, skill, agent, rules を配置
    └── alfred hook <event> → stdin JSON → 処理 → stdout JSON or exit 2
```

3つの柱 + 2つの防御層:
1. **壁** — PostToolUse (gate) → PreToolUse (DENY)
2. **Plan増幅** — UserPromptSubmit (template) + PermissionRequest (ExitPlanMode) + TaskCompleted (status同期)
3. **実行ループ** — Stop (Plan未完了block + pending-fixes block) + PreCompact/PostCompact/SessionEnd (handoff)
4. **サブエージェント制御** — SubagentStart (品質ルール注入) + SubagentStop
5. **自己防御** — ConfigChange (hook削除防止) + PostToolUseFailure (失敗追跡)

## 構造

```
src/
├── cli.ts                  # citty: init / hook / doctor
├── init.ts                 # セットアップ (14 hooks + skill + agent + rules + gates)
├── doctor.ts               # ヘルスチェック (8項目: bun, hooks, skill, agent, rules, gates, state, path)
├── hooks/
│   ├── dispatcher.ts       # event → handler ルーティング (14 events)
│   ├── respond.ts          # 共通: respond / deny / block
│   ├── post-tool.ts        # lint/type gate + pending-fixes + pace + batch + test-pass + verify
│   ├── pre-tool.ts         # pending-fixes → DENY + pace red → DENY + commit without test → DENY
│   ├── user-prompt.ts      # Plan テンプレート注入 + 大タスク検出
│   ├── permission-request.ts # ExitPlanMode: Review Gates 検証
│   ├── task-completed.ts   # Plan task status 自動同期
│   ├── session-start.ts    # .alfred作成 + gates自動検出 + handoff復元
│   ├── stop.ts             # pending-fixes block + Plan未完了block + レビュー強制 + pace警告
│   ├── pre-compact.ts      # 構造化ハンドオフ保存
│   ├── post-compact.ts     # コンパクション後ハンドオフ復元
│   ├── session-end.ts      # 割り込み終了時 handoff 保存
│   ├── subagent-start.ts   # サブエージェントに品質ルール注入
│   ├── subagent-stop.ts    # サブエージェント出力検証 + レビュー完了記録
│   ├── post-tool-failure.ts # ツール失敗追跡 + 2回連続→/clear
│   └── config-change.ts    # user_settings 変更 DENY
├── gates/
│   ├── runner.ts           # gate コマンド実行
│   ├── load.ts             # gates.json 読み込み
│   └── detect.ts           # package.json → gates.json 自動検出
├── state/
│   ├── pending-fixes.ts    # 未修正 lint/type エラー
│   ├── pace.ts             # Pace 追跡
│   ├── handoff.ts          # 構造化ハンドオフ
│   ├── plan-status.ts      # Plan task status 解析
│   ├── fail-count.ts       # 連続失敗カウント
│   ├── gate-batch.ts       # run_once_per_batch 実行履歴
│   ├── last-test-pass.ts  # テスト pass 記録 (commit 前強制)
│   └── last-review.ts    # レビュー完了記録 (Stop 時強制)
├── templates/              # init が配置するファイル
│   ├── skill-review.md     # /alfred:review skill
│   ├── agent-reviewer.md   # reviewer agent
│   └── rules-quality.md    # 品質ルール
└── types.ts
```

## コマンド

```bash
task build    # bun build (バンドル)
task check    # tsc --noEmit + Biome lint
task fix      # Biome 自動修正
task test     # vitest run
task clean    # ビルド成果物削除
```

`bun tsc` / `bun vitest` を使う（`npx` 不要）

## 設計原則

1. **リサーチ駆動** — 効果が実証された手法のみ実装 (research-harness-engineering-2026.md)
2. **壁 > 情報提示** — DENY (exit 2) > additionalContext
3. **少ない方が強い** — コンテキスト注入は最小限。指示は20行以内
4. **タスクサイズ制御** — 15 LOC以下・単一ファイル (SWE-bench: 80%+ 成功率)
5. **検証 > 指示** — 「何を検証すべきか」を伝える。HOW ではなく WHAT
6. **fail-open** — 全 hook は try-catch で握りつぶす。alfred の障害で Claude を止めない

## ルール

### ビルド
- `bun build.ts` → `dist/cli.mjs`
- `bun build.ts --compile` → シングルバイナリ
- **dependencies ゼロ** — 全て devDependencies + bun build バンドル

### Hook 設計
- 全 hook は fail-open (try-catch で握りつぶす)
- exit 2 = DENY/block (唯一の強制手段)。stderr にも理由を出力
- additionalContext = advisory (Claude は無視可能)
- PostToolUse 検出 → PreToolUse ブロックの二段構え
- SubagentStart でサブエージェントにも品質ルールを伝搬

### 状態ファイル (.alfred/.state/)
- pending-fixes.json — 未修正 lint/type エラー
- session-pace.json — Pace 追跡 (最終コミット時刻, 変更ファイル数, ツール呼出数)
- handoff.json — 構造化ハンドオフ (PreCompact/SessionEnd で保存)
- fail-count.json — 連続失敗カウント
- gate-batch.json — run_once_per_batch 実行履歴 (session_id ベース)
- last-test-pass.json — テスト pass 記録 (commit 前に必須)
- last-review.json — レビュー完了記録 (Plan 時 Stop 前に必須)

### Phase Gate (各 Phase 完了時に必ず実行)
1. `bun vitest run` — 全テスト pass
2. `bun vitest run src/__tests__/simulation.test.ts` — シミュレーション pass
3. `bun tsc --noEmit && bun biome check src/` — 型 + lint clean
4. セルフレビュー — ロジック・エッジケース・デザインを書き出す
5. コミット — Phase Gate 通過後にのみコミット

### シミュレーション
- Hook や状態管理の変更後は simulation.test.ts にシナリオを追加する
- シミュレーションは本番フロー (Edit→gate→pending-fixes→DENY) を再現する統合テスト

## 設計ドキュメント

- design-v0.1.md — v0.1.0 全体設計 (v0.2 の詳細設計含む)
- ROADMAP.md — v0.2〜v1.0 の全ロードマップ (詳細設計)
- research-harness-engineering-2026.md — リサーチ結果
- research-claude-code-plugins-2026.md — Plugin 調査結果
