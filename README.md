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

Claude Code 内で:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred@hir4ta/claude-alfred
```

Claude Code を終了し、ターミナルで:

```bash
go install github.com/hir4ta/claude-alfred@latest
```

Claude Code を再起動すれば完了。

**API キー**（任意）:

```bash
export VOYAGE_API_KEY=your-key       # セマンティック検索（Voyage AI voyage-4-large）
```

未設定の場合、検索は FTS5 キーワード検索にフォールバックします。

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
| `knowledge` | 全スキル | ハイブリッド vector + FTS5 によるドキュメント検索 |
| `review` | `setup` | プロジェクト設定の分析 |
| `ingest` | `harvest` | ドキュメントセクションを embedding 付きで保存 |

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

## ライセンス

MIT
