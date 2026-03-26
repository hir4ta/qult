# alfred

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) の性能を倍増させる執事。

## alfred が行うこと

alfred は Claude Code の 14 hooks として動作し、Claudeの行動を機械的に制御する。

### 壁 — 壊れたコードを通さない
- **PostToolUse**: ファイル編集後に lint/type gate 実行。テスト pass + gate 結果を記録。commit 後にクリア
- **PreToolUse**: pending-fixes 未修正 → **DENY**。Pace red zone → **DENY**。テスト未 pass or レビュー未実行で git commit → **DENY**

### Plan 増幅 — 設計の質を保証する
- **UserPromptSubmit**: Plan mode でタスク分解テンプレートを動的注入 (Short/Medium/Large)
- **PermissionRequest**: Plan に File/Verify/Review Gates がなければ **DENY**
- **TaskCompleted**: Claude がタスクを完了マークすると Plan の status を自動同期

### 実行ループ — 完了の質を保証する
- **Stop**: pending-fixes → **block**。Plan 未完了 → **block**。レビュー未実行 → **block**。Pace 警告
- **PreCompact**: コンパクション前に構造化ハンドオフ保存
- **PostCompact**: コンパクション後にハンドオフ復元コンテキスト注入
- **SessionStart**: .alfred 自動作成 + gates 自動検出 + ハンドオフ復元 + 頻出エラー注入
- **SessionEnd**: 割り込み終了時もハンドオフ保存

### サブエージェント制御 — 品質ルールを伝搬する
- **SubagentStart**: 全サブエージェントに品質ルール + pending-fixes 警告を注入
- **SubagentStop**: サブエージェント出力検証 (reviewer findings + Plan 構造) + レビュー完了記録

### 防御 — ハーネス自体を守る
- **PostToolUseFailure**: ツール失敗追跡。2回連続同じエラーで /clear 提案
- **ConfigChange**: user_settings の変更を **DENY** (hook 削除防止)

## インストール

```bash
bun install
bun build.ts
bun link          # 'alfred' コマンドをグローバルに利用可能にする

alfred init       # ~/.claude/ に hooks, skills, agents, rules を配置
alfred doctor     # セットアップの健全性を確認
```

## コマンド

```bash
alfred init          # セットアップ (14 hooks + skill + agent + rules + gates)
alfred hook <event>  # Hook イベント処理 (Claude Code が呼び出す)
alfred doctor        # ヘルスチェック (8項目: bun, hooks, skill, agent, rules, gates, state, path)
```

## Skills

- `/alfred:review` — 独立コードレビュー (HubSpot 2段階: Reviewer サブエージェント → Judge フィルタリング)

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)
