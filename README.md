# alfred

Claude Code の完全受動型執事。

主人が呼ぶまで沈黙。呼ばれたら、最高の知識を即座に渡す。
Claude Code の設定・ベストプラクティスに加え、ユーザーの技術スタックのドキュメントも知識ベースから検索し、最適な回答を提供する。

## Alfred ができること

**呼ばれたら** — 知識ベースから最適解を返す。
Claude Code の設定、プロジェクトのレビュー、スキル作成、CLAUDE.md の改善。
さらに、ユーザーが登録した技術ドキュメント（Next.js, Go, Prisma 等）も検索対象にできる。

**自動参照** — ユーザーの質問が知識ベースの技術に関連する場合、Claude が自動的に knowledge ツールを呼び出す。

**SessionStart** — セッション開始時に CLAUDE.md を自動取り込み。それだけ。

## 初回セットアップ

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
go install github.com/hir4ta/claude-alfred/cmd/alfred@latest
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
alfred setup
```

公式ドキュメント（1,400+ 件）を SQLite に取り込み、Voyage AI で embedding を生成する。
TUI で進捗を表示する。`~/.claude-alfred/sources.yaml` のテンプレートも自動生成される。

Claude Code を再起動すれば完了。

### ソースからビルド

```bash
git clone https://github.com/hir4ta/claude-alfred
cd claude-alfred
go build -o alfred ./cmd/alfred
```

## カスタムナレッジソース

自分の技術スタックの公式ドキュメントを知識ベースに追加できる。

### knowledge-curator エージェントで追加

Claude Code 内でエージェントを呼び出すと、対話的に URL を追加できる。
llms.txt / sitemap の確認、関連技術の提案も行う。

### 手動で追加

`~/.claude-alfred/sources.yaml` を編集:

```yaml
sources:
  - name: Next.js
    url: https://nextjs.org/docs
  - name: Go
    url: https://go.dev
    path_prefix: /doc/
  - name: Prisma
    url: https://www.prisma.io/docs
```

URL の発見順序: llms.txt → sitemap.xml → 単一ページ。

### クロール実行

```bash
alfred harvest
```

カスタムソースを含む全ドキュメントをクロールし、embedding を生成する。

### 自動更新

`knowledge` ツールが呼ばれるたびに、カスタムソースの鮮度を自動チェック。
7日以上古いソースはバックグラウンドで自動的にクロール+再ベクトル化される。
手動での `alfred harvest` は不要。

## アップデート

### 1. プラグインを更新

Claude Code 内で:

```
/plugin install alfred@hir4ta/claude-alfred
```

### 2. バイナリを更新

Claude Code を終了し、ターミナルで:

```bash
alfred update
```

最新バージョンを確認し、自動で `go install` を実行する。

### 3. Claude Code を再起動

更新完了。

## スキル (3)

Claude Code 内で `/alfred:<スキル名>` で呼び出す。

| スキル | 内容 |
|--------|------|
| `/alfred:configure <種類> [名前]` | 単一の設定ファイルを作成・更新（skill, rule, hook, agent, MCP, CLAUDE.md, memory）+ 独立レビュー |
| `/alfred:setup` | プロジェクト全体のセットアップウィザード — 複数ファイルのスキャン+設定、または Claude Code 機能の解説 |
| `/alfred:harvest [--force]` | ドキュメントから知識ベースを更新（カスタムソース含む） |

## エージェント (2)

| エージェント | 内容 |
|------------|------|
| `alfred` | Claude Code の設定・ベストプラクティスに関するサポート |
| `knowledge-curator` | 技術ドキュメント URL の追加（llms.txt/sitemap 確認 + 関連技術の提案） |

## MCP ツール (3)

スキルとエージェントのバックエンド。
Claude が必要に応じて自動的に呼び出すため、直接呼ぶ必要はない。

| ツール | 利用元 | 内容 |
|--------|--------|------|
| `knowledge` | 全スキル | ハイブリッド vector + FTS5 + Voyage rerank によるドキュメント検索 |
| `review` | `setup` | プロジェクト設定の分析 |
| `suggest` | 自動 | git diff を分析して .claude/ 設定の更新を提案 |

## コマンド

| コマンド | 内容 |
|----------|------|
| `serve` | MCP サーバー起動（stdio） |
| `setup` | 知識ベース初期化（TUI 進捗表示、seed + embedding 生成、sources.yaml テンプレート生成） |
| `harvest` | 知識ベース更新（カスタムソース含むクロール + embedding 再生成、TUI 進捗表示） |
| `hook <Event>` | Hook handler（Claude Code から呼ばれる） |
| `crawl-seed` | 公式ドキュメントをクロールして seed_docs.json 生成 |
| `plugin-bundle` | plugin/ ディレクトリ再生成 |
| `update` | 最新バージョンに更新（TUI 進捗表示） |
| `version` | バージョン表示 |

## 仕組み

```
┌─────────────────────────────────────────────┐
│           Claude Code セッション             │
│                                             │
│  Hook ──→ alfred.db                          │
│  SessionStart  (CLAUDE.md 自動取り込み)        │
│                                             │
│  あなた: 「Next.js の App Router で...」       │
│          ↓                                   │
│  ルール判定 → knowledge 自動呼び出し           │
│          ↓                                   │
│  カスタム + 公式ドキュメントから回答            │
└─────────────────────────────────────────────┘
```

**Hook** — SessionStart のみ。CLAUDE.md を docs テーブルに自動取り込み。

**自動参照ルール** — ユーザーの質問が知識ベースの技術に関連する場合、Claude が自動的に knowledge ツールを呼び出す。

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
| [yaml.v3](https://gopkg.in/yaml.v3) | カスタムソース設定パース |

## ライセンス

MIT
