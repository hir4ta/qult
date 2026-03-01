# alfred

Claude Code の静観型執事。

Alfred はコーディングセッションを静かに見守る。
口出しせず、提案せず、邪魔もしない。
でも振り向いた瞬間、すべてを把握している。
使っているツール、プロジェクト構成、セットアップを最高にする方法まで。

指図はしない。頼まれたことを、完璧にこなす。

## Alfred ができること

**作業中** — 透明人間。3つの無音フックがセッションデータを収集するだけ。
メッセージなし、アラートなし、割り込みなし。

**呼ばれたら** — すでにコンテキストを持っている。
プロジェクトのレビュー、スキル作成、CLAUDE.md の改善。
最新のベストプラクティスとあなたの好みに基づいた結果を即座に返す。

**記憶する** — 好みは全プロジェクトで永続化される。
「コミットは日本語で」「TDD で」と一度伝えれば、以降の生成物すべてに反映。

## インストール

**1. マーケットプレイスを追加**（初回のみ）:

```
/plugin marketplace add hir4ta/claude-alfred
```

**2. プラグインをインストール:**

```
/plugin install claude-alfred@hir4ta/claude-alfred
```

> スコープ: `--scope user`（デフォルト、個人用）、`--scope project`（git 共有）、`--scope local`（gitignore）

**3. API キーを設定:**

```bash
export VOYAGE_API_KEY=your-key
```

セマンティック検索に Voyage AI を使用（`voyage-4-large`, 1024d）。月額約 $0.50。

**4. Claude Code を再起動**してフックと MCP ツールを有効化。

### ソースからビルド

```bash
git clone https://github.com/hir4ta/claude-alfred
cd claude-alfred
go build -o claude-alfred .
```

### プラグイン管理

```
/plugin                           # 管理 UI（Discover / Installed / Marketplaces / Errors）
/plugin update claude-alfred@...  # 最新版に更新
/plugin disable claude-alfred@... # 一時的に無効化
/plugin uninstall claude-alfred@...  # 完全に削除
```

## スキル (16)

Claude Code 内で `/alfred:<スキル名>` で呼び出す。

### Create — 「作って」

| スキル | 内容 |
|--------|------|
| `/alfred:create-skill` | 公式テンプレートと好みを反映したスキルファイル生成 |
| `/alfred:create-rule` | パス指定付きルールファイル生成 |
| `/alfred:create-hook` | フック設定とハンドラスクリプト生成 |
| `/alfred:create-agent` | カスタムエージェント定義生成 |
| `/alfred:create-mcp` | `.mcp.json` に MCP サーバー設定を追加 |
| `/alfred:create-claude-md` | プロジェクト分析から CLAUDE.md を作成・改善 |
| `/alfred:create-memory` | プロジェクトメモリと MEMORY.md テンプレート生成 |

全 create スキルの最終ステップで**独立レビュー**が走る。
別コンテキストの Explore エージェントが、生成物を公式仕様と知識ベースに照らして検証する。

### Update — 「改善して」

| スキル | 内容 |
|--------|------|
| `/alfred:update <種類> [名前]` | 既存ファイルを最新ベストプラクティスで更新 |

対応: `skill`, `rule`, `hook`, `agent`, `claude-md`, `memory`, `mcp`

現在のファイルを読み、知識ベースと比較して diff を説明付きで提示。
承認後に適用し、create と同じ独立レビューを実行する。

### Analyze — 「どうかな？」

| スキル | 内容 |
|--------|------|
| `/alfred:review` | 総合レポート: 設定品質、機能活用度、改善提案 |
| `/alfred:audit` | ベストプラクティスとの簡易チェック（チェックリスト形式） |

### Learn — 「覚えて」

| スキル | 内容 |
|--------|------|
| `/alfred:learn` | 好みを記録（ワークフロー、コーディングスタイル、ツール） |
| `/alfred:preferences` | 記録済みの好みを一覧表示 |
| `/alfred:update-docs` | Claude Code ドキュメントをクロールして知識ベースに取り込み |

### Power — 「もっと活用」

| スキル | 内容 |
|--------|------|
| `/alfred:setup` | 対話式ウィザードで CLAUDE.md、スキル、ルール、フックを一括生成 |
| `/alfred:migrate` | 現在のセットアップと最新ベストプラクティスを比較して更新提案 |
| `/alfred:explain [機能名]` | Claude Code の機能を具体例付きで解説 |

## MCP ツール (4)

スキルと alfred エージェントのバックエンド。
Claude が必要に応じて自動的に呼び出すため、直接呼ぶ必要はない。

| ツール | 利用元 | 内容 |
|--------|--------|------|
| `knowledge` | 全スキル | ハイブリッド vector + FTS5 によるドキュメント検索 |
| `review` | `review`, `audit`, `setup`, `migrate` | プロジェクト設定とセッション履歴の分析 |
| `ingest` | `update-docs` | ドキュメントセクションを embedding 付きで保存 |
| `preferences` | `learn`, 全 `create-*`, `update` | ユーザーの好みを取得・設定 |

## 仕組み

```
┌───────────────────────────────────────────┐
│          Claude Code セッション            │
│                                           │
│  Hook（無音）──→ alfred.db                 │
│  SessionStart     (プロジェクト, ツール)    │
│  PostToolUse                              │
│  SessionEnd             ↑                 │
│                         │                 │
│  あなた: /alfred:create-skill              │
│          ↓                                │
│  スキル → MCP → knowledge + preferences    │
│          ↓                                │
│  ファイル生成                              │
│          ↓                                │
│  独立レビュー（Explore agent、別コンテキスト）│
│          ↓                                │
│  検証済み成果物                             │
└───────────────────────────────────────────┘
```

**Hook** — Claude Code のライフサイクルイベントで自動実行。出力は一切なし:

| Hook | タイミング | 記録内容 |
|------|-----------|---------|
| `SessionStart` | セッション開始時 | プロジェクトパス、git branch、セッション ID |
| `PostToolUse` | ツール実行後 | ツール名、成功/失敗、ファイルパス |
| `SessionEnd` | セッション終了時 | セッション統計（時間、ツール回数） |

**独立レビュー** — 全 create/update スキルは、ファイル生成後に別コンテキストで Explore エージェントを起動する。読み取り専用かつ知識ベース検索が可能で、公式仕様に対する客観的な検証を行う。

## TUI（オプション）

別ターミナルで `claude-alfred` を実行するとセッションをライブ監視できる。

```bash
claude-alfred          # セッション選択 + ライブモニター
claude-alfred browse   # 過去セッション閲覧
```

**キーバインド:** `↑↓` 移動、`Enter` 展開/折りたたみ、`g/G` 先頭/末尾、`?` ヘルプ、`q` 終了

## CLI コマンド

| コマンド | 説明 |
|---------|------|
| `claude-alfred` | アクティブセッション監視（デフォルト） |
| `claude-alfred browse` | 過去セッション閲覧 |
| `claude-alfred serve` | MCP サーバー起動（stdio、プラグインが使用） |
| `claude-alfred hook <Event>` | フックイベント処理（プラグインが使用） |
| `claude-alfred install` | セッション同期と embedding 生成 |
| `claude-alfred uninstall` | MCP サーバー登録解除 |
| `claude-alfred analyze` | セッション分析レポート |
| `claude-alfred plugin-bundle` | plugin ディレクトリ再生成 |
| `claude-alfred version` | バージョン表示 |

## 依存ライブラリ

| ライブラリ | 用途 |
|-----------|------|
| [bubbletea](https://github.com/charmbracelet/bubbletea) | TUI フレームワーク |
| [lipgloss](https://github.com/charmbracelet/lipgloss) | TUI スタイリング |
| [fsnotify](https://github.com/fsnotify/fsnotify) | ファイル変更監視 |
| [mcp-go](https://github.com/mark3labs/mcp-go) | MCP サーバー SDK |
| [go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite ドライバ（pure Go, WASM） |

## ライセンス

MIT
