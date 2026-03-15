# alfred

[![Version](https://img.shields.io/github/v/tag/hir4ta/claude-alfred?label=version&sort=semver)](https://github.com/hir4ta/claude-alfred/releases)
[![Go](https://img.shields.io/badge/go-%3E%3D1.25-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![MIT License](https://img.shields.io/github/license/hir4ta/claude-alfred)](https://github.com/hir4ta/claude-alfred/blob/main/LICENSE)

Claude Code の開発執事。

[English README](README.md)

## 何が辛いのか

Claude Code で開発してると、こうなる:

- **忘れる。** Compact するたび、セッション切れるたび、全部消える。20分かけた設計判断、もう一回聞かれる。
- **行き当たりばったり。** 仕様もなく、計画もなく、ノリで実装。動くけど、壊れる。
- **誰もレビューしない。** コードがそのまま出ていく。バグは本番で見つかる。

alfred は3つとも潰す。

## 何ができるか

**消えない仕様。** 要件、設計、決定、セッション状態 — 構造化されたMarkdownファイルが Compact を跨いで生き残る。コンテキストは一度も失われない。

**積み重なる記憶。** 「あの時こう決めた」「このバグ前にも見た」「Xは試したけどダメだった」— 全てがセマンティックメモリに保存される。次に似た問題に当たったとき、聞く前に alfred が出してくる。

**スケールするレビュー。** 6つのレビュープロファイル（code, config, security, docs, architecture, testing）、それぞれにチェックリスト。並列エージェント、スコア付きレポート、具体的な修正案。

**承認ゲート。** 実装前に仕様のレビューサイクルを回す。TUI ダッシュボードで任意の行にコメントして、承認か差し戻し — GitHub の PR レビューと同じ体験を、仕様に対してやる。

## セットアップ

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred
```

```bash
export VOYAGE_API_KEY=your-key  # ~/.zshrc に追加 — セマンティック検索が有効に（1セッション約$0.01）
```

これだけ。Hook は自動で動く。記憶は勝手に溜まる。コンテキストは勝手に残る。

Voyage のキーがなくても動く。FTS5 全文検索がフォールバックする。

## スキル

| スキル | やること |
|--------|----------|
| `/alfred:brief` | 仕様を設計する。3エージェントがアーキテクチャを議論し、ダッシュボードで承認する |
| `/alfred:attend` | 全自動。仕様→レビュー→承認→実装→テスト→コミットまで放置でOK |
| `/alfred:tdd` | テスト駆動。red→green→refactor を自律サイクルで回す。テストパターンも記憶する |
| `/alfred:inspect` | 品質ゲート。6プロファイル並列レビュー、スコア付きレポート |
| `/alfred:mend` | バグ修正。再現→原因特定（過去のバグ記憶も使う）→修正→検証→コミット |
| `/alfred:survey` | 既存コードから仕様をリバースエンジニアリング。信頼度スコア付き |
| `/alfred:salon` | ブレスト。3人の専門家が並列でアイデアを出して、議論する |
| `/alfred:harvest` | PR レビューコメントからナレッジを抽出して永続メモリに保存 |
| `/alfred:furnish` | 設定ファイルの作成・ブラッシュアップ |
| `/alfred:quarters` | プロジェクト全体のセットアップウィザード |
| `/alfred:archive` | 参照資料を検索可能なナレッジに変換 |
| `/alfred:concierge` | 全機能のクイックリファレンス |

## MCP ツール

| ツール | 役割 |
|--------|------|
| `dossier` | 仕様のライフサイクル管理 — init, update, status, switch, complete, delete, history, rollback, review |
| `roster` | エピック管理 — タスクのグループ化、依存関係、進捗追跡 |
| `ledger` | メモリ — 過去の決定や経験の検索・保存 |

## Hook

全自動。触らなくていい。

| イベント | 動作 |
|----------|------|
| SessionStart | 仕様コンテキスト復元 + CLAUDE.md 取込 + プロジェクト成熟度に応じた注入量調整 |
| PreCompact | 決定抽出 → 構造化チャプターメモリ (JSON) 保存 → エピック進捗同期 |
| UserPromptSubmit | セマンティック検索 + ファイルコンテキストブースト → 関連する過去の経験を注入 |
| PostToolUse | Bash エラー検出 → 類似の過去の修正をメモリから検索して提示 |

## TUI ダッシュボード

```bash
alfred dashboard
```

| タブ | 表示内容 |
|------|----------|
| Overview | アクティブタスク詳細 — 進捗、Next Steps、ブロッカー、意思決定 |
| Tasks | 全タスク一覧 — 進捗バー、ステータス |
| Specs | ファイルブラウザ + インラインレビューモード（行コメント、承認/差し戻し） |
| Knowledge | セマンティック検索 — メモリと仕様を横断 |

着手中のタスクがシマーで光る。何が進行中か、一目でわかる。

## 検索パイプライン

キーワードマッチだけじゃない。3段階の検索パイプライン:

1. **Voyage AI ベクトル検索** + リランキング（API キーがあるとき）
2. **FTS5 全文検索** — タグエイリアス展開 + ファジーマッチ付き
3. **キーワードフォールバック**（LIKE クエリ）

タグエイリアスが検索を自動拡張する: 「auth」で「authentication」「login」「認証」もヒットする。

ファジーマッチがタイポを吸収する:「authetication」でも「authentication」が見つかる。

## 仕組み

```
あなた
  |
  |-- /alfred:brief    -> 仕様 + 3エージェント議論 + ダッシュボード承認
  |-- /alfred:attend   -> 全自動: 仕様 → 承認 → 実装 → レビュー → コミット
  |-- /alfred:mend     -> 再現 → 原因分析（＋過去バグ記憶）→ 修正 → 検証
  |
  v
Hook（見えない）
  |-- SessionStart     -> コンテキスト復元、プロジェクト成熟度に適応
  |-- PreCompact       -> 決定をJSON保存、チャプターメモリ、エピック進捗
  |-- UserPromptSubmit -> ベクトル検索 + FTS5 + ファイルブースト → メモリ注入
  |-- PostToolUse      -> エラー検出 → 関連する過去の修正を提示
  |
  v
ストレージ
  |-- .alfred/specs/       -> 仕様ファイル + バージョン履歴 + レビュー
  |-- .alfred/epics/       -> エピック YAML + タスク依存関係
  |-- .alfred/audit.jsonl  -> 操作監査ログ
  |-- .alfred/knowledge/   -> エクスポートされたメモリ（Git共有可能）
  +-- ~/.claude-alfred/    -> SQLite（records + FTS5 + Voyage embeddings）
```

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| メモリ検索で結果が出ない | `export VOYAGE_API_KEY=your-key` — またはFTS5フォールバックの動作確認 |
| Hook が動かない | `/plugin install alfred` して再起動 |
| ダッシュボードが空 | `.alfred/specs/` があるディレクトリで `alfred dash` |
| レート制限エラー | 対策済み — エージェントは段階的バッチ起動（最大2並列） |

## ライセンス

MIT
