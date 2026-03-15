# alfred

[![Version](https://img.shields.io/github/v/tag/hir4ta/claude-alfred?label=version&sort=semver)](https://github.com/hir4ta/claude-alfred/releases)
[![Go](https://img.shields.io/badge/go-%3E%3D1.25-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![MIT License](https://img.shields.io/github/license/hir4ta/claude-alfred)](https://github.com/hir4ta/claude-alfred/blob/main/LICENSE)

仕様を管理し、経験を記憶し、品質を見守る開発執事。

[English README](README.md)

## alfred が解決する痛み

**仕様なしの AI コーディングは結果がブレる。** alfred は Claude Code に仕様駆動開発を持ち込む。要件・設計・決定・セッション状態を構造化し、Compact やセッション喪失を跨いで保持する。

**過去の決定やバグ修正が忘れられる。** alfred は覚えている。すべての決定、すべての修正がセマンティックメモリとして保存され、関連する場面で自動的に提示される — Voyage AI のベクトル検索で、毎回のプロンプトで。

**コードレビューが属人的。** alfred は 6 プロファイル並列レビュー（code, config, security, docs, architecture, testing）をチェックリスト付きで実行し、スコア付きレポートを生成する。

**Compact でコンテキストが消える。** alfred の Hook が決定を自動抽出し、変更ファイルを追跡し、コンテキストを復元する。手動操作は不要。

## セットアップ

### 1. プラグイン追加

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred
```

初回実行時にバイナリが自動ダウンロードされます。

### 2. API キー設定（オプション）

```bash
export VOYAGE_API_KEY=your-key  # ~/.zshrc に追加
```

[Voyage AI](https://voyageai.com/) でセマンティック検索が有効に（1セッションあたり約 $0.01）。なくてもキーワード検索で動作する。

## スキル (12)

| スキル | 内容 |
|--------|------|
| `/alfred:brief` | 仕様準備 — 3 エージェント（Architect, Devil's Advocate, Researcher）が設計を議論 |
| `/alfred:attend` | 完全自律 — 仕様作成→実装→レビュー→テスト→コミットまで介入不要 |
| `/alfred:inspect` | 品質レビュー — 6 プロファイル＋チェックリスト、スコア付きレポート |
| `/alfred:mend` | バグ修正 — 再現→原因分析（過去のバグ記憶活用）→修正→検証→コミット |
| `/alfred:survey` | リバースエンジニアリング — 既存コードから仕様を逆生成、信頼度スコア付き |
| `/alfred:salon` | ブレスト — 3 専門家が並列でアイデア生成→議論 |
| `/alfred:polish` | 壁打ち — 選択肢を絞り、スコアリングし、決定 |
| `/alfred:valet` | スキル監査 — Anthropic 公式ガイドに基づく 21 チェック項目 |
| `/alfred:furnish` | 設定ファイル作成・更新（skill, rule, hook, agent, MCP） |
| `/alfred:quarters` | プロジェクト全体のセットアップウィザード |
| `/alfred:archive` | 参照資料を永続ナレッジに変換 |
| `/alfred:concierge` | 全機能のクイックリファレンス |

## MCP ツール (2)

| ツール | 内容 |
|--------|------|
| `dossier` | 仕様管理 — init, update, status, switch, delete, history, rollback |
| `ledger` | メモリ — 過去の決定・経験の検索・保存 |

## Hook (3)

自動実行。ユーザーが意識する必要なし。

| イベント | 動作 |
|----------|------|
| SessionStart | 仕様コンテキスト復元 + CLAUDE.md 取込 |
| PreCompact | 決定抽出 + 変更ファイル追跡 + セッション状態保存 + メモリ永続化 |
| UserPromptSubmit | セマンティック検索 — 関連する過去の経験を自動提示 |

## 仕組み

```
あなた（開発者）
  │
  ├── /alfred:brief    → .alfred/specs/{task}/（要件・設計・決定・セッション）
  ├── /alfred:attend   → 自律: 仕様 → レビュー → 実装 → レビュー → テスト → コミット
  ├── /alfred:mend     → 再現 → 原因分析（＋過去バグ記憶）→ 修正 → 検証 → コミット
  └── /alfred:survey   → 既存コード → 信頼度スコア付き仕様ファイル
  │
  ▼
Hook（自動、バックグラウンド）
  ├── SessionStart     → 仕様 + CLAUDE.md からコンテキスト復元
  ├── PreCompact       → 決定保存、セッション状態、チャプターメモリ
  └── UserPromptSubmit → ベクトル検索 → 関連メモリ注入
  │
  ▼
ストレージ
  ├── .alfred/specs/   → 仕様ファイル（markdown、バージョン履歴）
  └── ~/.claude-alfred/alfred.db → SQLite（docs + Voyage AI embeddings）
```

## 依存ライブラリ

| ライブラリ | 用途 |
|-----------|------|
| [mcp-go](https://github.com/mark3labs/mcp-go) | MCP サーバー SDK |
| [go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite（pure Go, WASM） |
| [Voyage AI](https://voyageai.com/) | embedding + rerank（voyage-4-large） |

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| メモリ検索結果がない | `export VOYAGE_API_KEY=your-key` |
| Hook が発火しない | `/plugin install alfred` して再起動 |

## ライセンス

MIT
