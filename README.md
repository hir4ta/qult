# alfred

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) の性能を倍増させる執事。

## alfred が行うこと

alfred は Claude Code の 14 hooks として動作し、Claudeの行動を機械的に制御する。

### 壁 — 壊れたコードを通さない
- **PostToolUse**: ファイル編集後に lint/type チェック。エラーを pending-fixes に記録
- **PreToolUse**: 未修正エラーがあれば他ファイルの編集を **DENY**。Pace red zone も DENY

### Plan 増幅 — 設計の質を保証する
- **UserPromptSubmit**: Plan mode でタスク分解テンプレート (1ファイル/15行/検証テスト + Review Gates) を注入
- **PermissionRequest**: Plan に Review Gates がなければ **DENY**
- **TaskCompleted**: Claude がタスクを完了マークすると Plan の status を自動同期

### 実行ループ — 完了の質を保証する
- **Stop**: pending-fixes 残存 or Plan 未完了タスク → **block**。Pace 警告
- **PreCompact**: コンパクション前に構造化ハンドオフ保存
- **PostCompact**: コンパクション後にハンドオフ復元コンテキスト注入
- **SessionStart**: .alfred 自動作成 + gates 自動検出 + ハンドオフ復元
- **SessionEnd**: 割り込み終了時もハンドオフ保存

### サブエージェント制御 — 品質ルールを伝搬する
- **SubagentStart**: 全サブエージェントに品質ルール + pending-fixes 警告を注入
- **SubagentStop**: サブエージェント完了検証 (拡張ポイント)

### 防御 — ハーネス自体を守る
- **PostToolUseFailure**: ツール失敗追跡。2回連続同じエラーで /clear 提案
- **ConfigChange**: user_settings の変更を **DENY** (hook 削除防止)

## インストール

```bash
bun install
bun build.ts
bun link          # 'alfred' コマンドをグローバルに利用可能にする

alfred init       # ~/.claude/ に hooks, skills, agents, rules を配置
```

## コマンド

```bash
alfred init          # セットアップ (14 hooks + skill + agent + rules + gates)
alfred hook <event>  # Hook イベント処理 (Claude Code が呼び出す)
alfred doctor        # ヘルスチェック (8項目: bun, hooks, skill, agent, rules, gates, state, path)
```

## Skills

- `/alfred:review` — マルチエージェントコードレビュー (correctness / design / security + Judge フィルタリング)

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)
