# alfred

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) の品質バトラー。Claude Code の動作を監視し、品質ゲートを強制し、過去のセッションから学習する。

**不可視。機械的。容赦なし。**

## alfred が行うこと

alfred は Claude Code 内部で hooks + MCP サーバーとして動作する。すべてのファイル編集、bash コマンド、コミットを監視し、提案ではなく「壁」で品質を強制する。

- **Lint/型ゲート**: PostToolUse がファイル書き込み後に lint と型チェックを実行。エラーは DIRECTIVE → 修正するまで次の編集をブロック (DENY)
- **Convention 壁**: regex ベースの convention 違反検出 → DIRECTIVE + pending-fixes → DENY
- **テスト先行強制**: UserPromptSubmit が実装系プロンプトを検出し、テスト先行 DIRECTIVE を注入
- **Plan Mode 最強化**: plan/design 意図検出で Phase 構造テンプレートを DIRECTIVE 注入。plan ファイル書き込み時に構造検証
- **知識自動蓄積**: エラー解決 (error_resolution)、lint 修正パターン (fix_pattern)、設計意思決定 (decision) を自動で DB + Voyage embed に保存
- **知識自動注入**: 過去のエラー解決策、修正パターン、意思決定を Voyage ベクトル検索で自動注入
- **品質スコアリング**: すべてのゲート pass/fail、エラー hit/miss を追跡しスコアリング (0-100)
- **セルフリフレクション**: コミットゲートで4項目の検証チェックリストを注入

## アーキテクチャ

```
User → Claude Code → (alfred hooks: 監視 + コンテキスト注入 + ゲート)
              ↓ 必要な時だけ
           alfred MCP (知識DB)
```

| コンポーネント | 役割 | 比重 |
|---|---|---|
| Hooks (6 events) | 監視、コンテキスト注入、品質ゲート | 70% |
| DB + Voyage AI | 知識蓄積、ベクトル検索 | 20% |
| MCP tool | Claude Code → 知識DBインターフェース | 10% |

## 知識タイプ

| タイプ | 蓄積 | 注入タイミング |
|---|---|---|
| error_resolution | 自動 (Bash エラー→成功検出) | Bash エラー時に Voyage 検索→CONTEXT |
| fix_pattern | 自動 (lint fail→pass サイクル) | 実装プロンプト時に Voyage 検索→CONTEXT |
| convention | init 時自動生成 + `/alfred:conventions` | SessionStart で注入 + Edit 後に regex 違反検出 |
| decision | 自動 (plan Write + commit メッセージ) | plan/design プロンプト時に Voyage 検索→CONTEXT |

## インストール

```bash
# ビルド
bun install
bun build.ts
bun link          # 'alfred' コマンドをグローバルに利用可能にする

# セットアップ (~/.claude/ に設定を配置)
alfred init
```

必須: `VOYAGE_API_KEY` 環境変数 (https://dash.voyageai.com/ で取得)

## コマンド

```bash
alfred init          # セットアップ: MCP, hooks, rules, skills, agents, gates
alfred serve         # MCP サーバー起動 (stdio, Claude Code が呼び出す)
alfred hook <event>  # Hook イベント処理 (Claude Code が呼び出す)
alfred status        # プロジェクトの品質状態を表示
alfred tui           # ターミナル品質ダッシュボード
alfred scan          # フル品質スキャン (lint/型/テスト + スコア)
alfred doctor        # インストール健全性チェック
alfred uninstall     # alfred をシステムから削除
alfred version       # バージョン表示
```

## Skills

- `/alfred:review` — Judge フィルタリング付きマルチエージェントコードレビュー (HubSpot 3基準パターン)
- `/alfred:conventions` — コードベースのコーディング規約を検出し、採用率を表示

## TUI ダッシュボード

```bash
task tui   # or: bun src/tui/main.tsx
```

表示内容: 品質スコア、ゲート pass/fail、知識ヒット、直近イベントストリーム、セッション情報。`?` でヘルプ (Tab で EN/JA 切替)。

## スタック

TypeScript (Bun 1.3+, ESM) / SQLite (bun:sqlite) / Voyage AI (voyage-4-large + rerank-2.5) / MCP SDK / TUI (OpenTUI)

## 設計ドキュメント

`design/` にアーキテクチャ、詳細設計、リサーチ参考文献を配置。
