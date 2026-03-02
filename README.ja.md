# alfred

Claude Code の静観型執事。

Alfred はコーディングセッションを静かに見守る。
口出しせず、提案せず、邪魔もしない。
でも振り向いた瞬間、すべてを把握している。
使っているツール、プロジェクト構成、セットアップを最高にする方法まで。

指図はしない。頼まれたことを、完璧にこなす。

## Alfred ができること

**作業中** — 透明人間。8つの無音フックがセッションデータを収集するだけ。
メッセージなし、アラートなし、割り込みなし。

**呼ばれたら** — すでにコンテキストを持っている。
プロジェクトのレビュー、スキル作成、CLAUDE.md の改善。
最新のベストプラクティスとあなたの好みに基づいた結果を即座に返す。

**歴史から学ぶ** — Decision、共変更ファイル、ツール失敗パターンをセッション横断で追跡。
ファイルに触れた瞬間、聞かれる前に必要な情報を差し出す。

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

`/alfred:configure` の最終ステップで**独立レビュー**が走る。
別コンテキストの Explore エージェントが、生成物を公式仕様と知識ベースに照らして検証する。

## MCP ツール (4)

スキルと alfred エージェントのバックエンド。
Claude が必要に応じて自動的に呼び出すため、直接呼ぶ必要はない。

| ツール | 利用元 | 内容 |
|--------|--------|------|
| `knowledge` | 全スキル | ハイブリッド vector + FTS5 によるドキュメント検索 |
| `recall` | コンテキスト注入、agent | 過去セッションのプロジェクト記憶を呼び出し（decisions, 共変更ファイル, hotspots） |
| `review` | `setup` | プロジェクト設定とセッション履歴の分析 |
| `ingest` | `harvest` | ドキュメントセクションを embedding 付きで保存 |

## 仕組み

```
┌─────────────────────────────────────────────┐
│           Claude Code セッション             │
│                                             │
│  Hook ──→ alfred.db                          │
│  SessionStart  (プロジェクト + CLAUDE.md)     │
│  PostToolUse / PostToolUseFailure (ツール統計)│
│  SubagentStart → subagent コンテキスト注入   │
│  Stop / SubagentStop → Decision 抽出          │
│  UserPromptSubmit → 過去 decisions 注入   ↑  │
│  SessionEnd                               │  │
│                                           │  │
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

**Hook** — Claude Code のライフサイクルイベントで自動実行。`UserPromptSubmit` のみコンテキスト注入あり:

| Hook | タイミング | 動作 |
|------|-----------|------|
| `SessionStart` | セッション開始時 | プロジェクト記録 + CLAUDE.md 自動取り込み + 品質スコア + hotspot + コンパクション後のコンテキスト再注入 |
| `PostToolUse` | ツール成功後 | ツール名と統計を記録 |
| `PostToolUseFailure` | ツール失敗後 | ツール失敗を記録 |
| `UserPromptSubmit` | プロンプト送信時 | 言及ファイルの過去 decisions + 共変更ファイル + ツール失敗パターンを注入 |
| `SubagentStart` | subagent 起動時 | コンパクトコンテキスト（decisions + ファイル + hotspot + ツール失敗）を注入 |
| `Stop` | アシスタント応答終了時 | 応答から Decision を抽出（非同期） |
| `SubagentStop` | subagent 終了時 | subagent 応答から Decision を抽出（非同期） |
| `SessionEnd` | セッション終了時 | セッション統計の確定 |

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
