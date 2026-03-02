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

```bash
curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-alfred/main/install.sh | sh
```

バイナリのダウンロード、フック・MCP・スキルの登録、セッション履歴の同期まで一括で行う。
インストール後は Claude Code を再起動。

**API キー**（セマンティック検索に必要）:

```bash
export VOYAGE_API_KEY=your-key
```

Voyage AI `voyage-4-large`（1024d）。月額約 $0.50。

## アンインストール

```bash
alfred uninstall
```

フック、MCP サーバー、スキル、エージェント、ルール、データベース、バイナリをすべて削除する。

### 別の方法: プラグインインストール

Claude Code のプラグインシステムからもインストールできる:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred@hir4ta/claude-alfred
```

### ソースからビルド

```bash
git clone https://github.com/hir4ta/claude-alfred
cd claude-alfred
go build -o alfred .
./alfred install
```

## スキル (7)

Claude Code 内で `/alfred:<スキル名>` で呼び出す。

| スキル | 内容 |
|--------|------|
| `/alfred:inspect [--quick]` | プロジェクト分析 — 総合レポート、簡易監査、移行チェック |
| `/alfred:prepare <種類> [名前]` | 設定ファイル新規作成（skill, rule, hook, agent, MCP, CLAUDE.md, memory） |
| `/alfred:polish <種類> [名前]` | 既存ファイルを最新ベストプラクティスで更新 |
| `/alfred:greetings` | 新プロジェクト向け対話式セットアップウィザード |
| `/alfred:brief <機能名>` | Claude Code の機能を具体例付きで解説 |
| `/alfred:memorize [好み]` | 好みの記録・表示（コーディングスタイル、ワークフロー、ツール） |
| `/alfred:harvest [--force]` | 知識ベースの手動更新（auto-harvest は SessionStart で自動実行） |

`/alfred:prepare` と `/alfred:polish` の最終ステップで**独立レビュー**が走る。
別コンテキストの Explore エージェントが、生成物を公式仕様と知識ベースに照らして検証する。

## MCP ツール (5)

スキルと alfred エージェントのバックエンド。
Claude が必要に応じて自動的に呼び出すため、直接呼ぶ必要はない。

| ツール | 利用元 | 内容 |
|--------|--------|------|
| `knowledge` | 全スキル | ハイブリッド vector + FTS5 によるドキュメント検索 |
| `recall` | コンテキスト注入、agent | 過去セッションのプロジェクト記憶を呼び出し（decisions, 共変更ファイル, hotspots） |
| `review` | `inspect`, `greetings` | プロジェクト設定とセッション履歴の分析 |
| `ingest` | `harvest`, auto-harvest | ドキュメントセクションを embedding 付きで保存 |
| `preferences` | `memorize`, `prepare`, `polish` | ユーザーの好みを取得・設定 |

## 仕組み

```
┌───────────────────────────────────────────┐
│          Claude Code セッション            │
│                                           │
│  Hook ──→ alfred.db                        │
│  SessionStart  (プロジェクト + CLAUDE.md)   │
│  PostToolUse   (ツール統計)                │
│  UserPromptSubmit → 過去 decisions 注入    │
│  SessionEnd              ↑                │
│                          │                │
│  あなた: /alfred:prepare skill              │
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

**Hook** — Claude Code のライフサイクルイベントで自動実行。`UserPromptSubmit` のみコンテキスト注入あり:

| Hook | タイミング | 動作 |
|------|-----------|------|
| `SessionStart` | セッション開始時 | プロジェクト記録 + CLAUDE.md 自動取り込み + changelog 自動取得 |
| `PostToolUse` | ツール実行後 | ツール名、成功/失敗を記録 |
| `UserPromptSubmit` | プロンプト送信時 | 言及ファイルの過去 decisions をコンテキストとして注入 |
| `SessionEnd` | セッション終了時 | セッション統計の確定 |

**独立レビュー** — `/alfred:prepare` と `/alfred:polish` は、ファイル生成後に別コンテキストで Explore エージェントを起動する。読み取り専用かつ知識ベース検索が可能で、公式仕様に対する客観的な検証を行う。

## TUI（オプション）

別ターミナルで `alfred` を実行するとセッションをライブ監視できる。

```bash
alfred          # セッション選択 + ライブモニター
alfred browse   # 過去セッション閲覧
```

**キーバインド:** `↑↓` 移動、`Enter` 展開/折りたたみ、`g/G` 先頭/末尾、`?` ヘルプ、`q` 終了

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
