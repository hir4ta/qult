# alfred

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) の性能を倍増させる執事。

## alfred が行うこと

alfred は Claude Code の hooks として動作し、3つの柱で品質を強制する。

1. **壁** — ファイル編集後に lint/type チェック。エラーがあれば次の編集をブロック (DENY)
2. **Plan 増幅** — Plan mode でタスク分解テンプレートとレビューゲートを注入
3. **実行ループ** — Pace 制御、2回失敗検出、構造化ハンドオフ

## インストール

```bash
bun install
bun build.ts
bun link          # 'alfred' コマンドをグローバルに利用可能にする

alfred init       # ~/.claude/ に hooks, skills, agents, rules を配置
```

## コマンド

```bash
alfred init          # セットアップ
alfred hook <event>  # Hook イベント処理 (Claude Code が呼び出す)
alfred doctor        # ヘルスチェック
```

## Skills

- `/alfred:review` — マルチエージェントコードレビュー (3視点 + Judge フィルタリング)

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)

## 設計ドキュメント

- `design-v0.1.md` — v0.1.0 全体設計
- `research-harness-engineering-2026.md` — ハーネスエンジニアリング リサーチ
- `research-claude-code-plugins-2026.md` — Claude Code Plugin 調査
