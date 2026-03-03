# alfred

Claude Code の完全受動型執事。

主人が呼ぶまで沈黙。呼ばれたら、最高の知識を即座に渡す。
Claude Code の設定・ベストプラクティス・ドキュメントを知識ベースから検索し、最適な回答を提供する。

## Alfred ができること

**呼ばれたら** — Claude Code の知識ベースから最適解を返す。
プロジェクトのレビュー、スキル作成、CLAUDE.md の改善。
最新のベストプラクティスに基づいた結果を即座に返す。

**SessionStart** — セッション開始時に CLAUDE.md を自動取り込み。それだけ。

## インストール

### 1. プラグインを追加

Claude Code 内で:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred@hir4ta/claude-alfred
```

プラグイン（skills, rules, hooks, agents, MCP 設定）が配置される。

### 2. バイナリをインストール

ターミナルで:

```bash
go install github.com/hir4ta/claude-alfred@latest
```

MCP サーバーと Hook handler のバイナリをコンパイルする。
初回は依存ライブラリのビルドに 30〜60 秒かかる。

### 3. API キーを設定

```bash
export VOYAGE_API_KEY=your-key  # ~/.zshrc 等に追加
```

セマンティック検索に [Voyage AI](https://voyageai.com/) を使用する。

### 4. 知識ベースを初期化

```bash
claude-alfred setup
```

公式ドキュメント（1,400+ 件）を SQLite に取り込み、Voyage AI で embedding を生成する。
TUI で進捗を表示する。

Claude Code を再起動すれば完了。

### ソースからビルド

```bash
git clone https://github.com/hir4ta/claude-alfred
cd claude-alfred
go build -o claude-alfred .
```

## スキル (3)

Claude Code 内で `/alfred:<スキル名>` で呼び出す。

| スキル | 内容 |
|--------|------|
| `/alfred:configure <種類> [名前]` | 単一の設定ファイルを作成・更新（skill, rule, hook, agent, MCP, CLAUDE.md, memory）+ 独立レビュー |
| `/alfred:setup` | プロジェクト全体のセットアップウィザード — 複数ファイルのスキャン+設定、または Claude Code 機能の解説 |
| `/alfred:harvest [--force]` | Claude Code ドキュメントから知識ベースを更新 |

## MCP ツール (3)

スキルと alfred エージェントのバックエンド。
Claude が必要に応じて自動的に呼び出すため、直接呼ぶ必要はない。

| ツール | 利用元 | 内容 |
|--------|--------|------|
| `knowledge` | 全スキル | ハイブリッド vector + FTS5 + Voyage rerank によるドキュメント検索 |
| `review` | `setup` | プロジェクト設定の分析 |
| `ingest` | `harvest` | ドキュメントセクションを embedding 付きで保存 |

## コマンド

| コマンド | 内容 |
|----------|------|
| `serve` | MCP サーバー起動（stdio） |
| `setup` | 知識ベース初期化（TUI 進捗表示、seed + embedding 生成） |
| `hook <Event>` | Hook handler（Claude Code から呼ばれる） |
| `crawl-seed` | 公式ドキュメントをクロールして seed_docs.json 生成 |
| `plugin-bundle` | plugin/ ディレクトリ再生成 |
| `version` | バージョン表示 |

## 仕組み

```
┌─────────────────────────────────────────────┐
│           Claude Code セッション             │
│                                             │
│  Hook ──→ alfred.db                          │
│  SessionStart  (CLAUDE.md 自動 ingest)       │
│                                             │
│  あなた: /alfred:configure skill               │
│          ↓                                   │
│  スキル → MCP → knowledge base               │
│          ↓                                   │
│  ファイル生成                                 │
│          ↓                                   │
│  独立レビュー（Explore agent、別コンテキスト）  │
│          ↓                                   │
│  検証済み成果物                               │
└─────────────────────────────────────────────┘
```

**Hook** — SessionStart のみ。CLAUDE.md を docs テーブルに自動取り込み。

**独立レビュー** — `/alfred:configure` は、ファイル生成後に別コンテキストで Explore エージェントを起動する。読み取り専用かつ知識ベース検索が可能で、公式仕様に対する客観的な検証を行う。

## デバッグ

`ALFRED_DEBUG=1` を設定すると `~/.claude-alfred/debug.log` にデバッグログを出力する。

## 依存ライブラリ

| ライブラリ | 用途 |
|-----------|------|
| [mcp-go](https://github.com/mark3labs/mcp-go) | MCP サーバー SDK |
| [go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite ドライバ（pure Go, WASM） |
| [bubbletea](https://github.com/charmbracelet/bubbletea) | TUI フレームワーク（setup 画面） |
| [Voyage AI](https://voyageai.com/) | embedding + rerank（voyage-4-large, 1024d） |

## ライセンス

MIT
