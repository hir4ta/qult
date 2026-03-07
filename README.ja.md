# alfred

Claude Code の能動型アシスタント。

バックグラウンドで静かに動き、関連するナレッジを能動的に提供し、スコープ違反を検出し、Compact を跨いでセッションコンテキストを保持する。開発に集中できる。

[English README](README.md)

## alfred ができること

**能動的ナレッジ注入** — 1,400+ ドキュメントの知識ベースから、Claude Code の設定やアーキテクチャ判断に関連するベストプラクティスを自動で提供。

**Alfred Protocol** — Compact/セッション喪失に強い構造化 spec 管理。要件・設計・決定・セッション状態を `.alfred/specs/` に保存し、自動的にコンテキストを保持・復帰する。

**3層コードレビュー** — 変更をアクティブ spec（スコープ違反、決定との矛盾）、セマンティックナレッジ検索、ドキュメントのベストプラクティスと照合。

**Compact 耐性** — PreCompact hook が決定を自動検出し、変更ファイルを追跡し、activeContext 形式でセッション状態を保存。SessionStart hook が Compact 後にフルコンテキストを復元。

## 初回セットアップ

### 1. alfred をインストール

```bash
brew install hir4ta/alfred/alfred
```

### 2. プラグインを追加

Claude Code 内で

```
/plugin marketplace add hir4ta/claude-alfred   # マーケットプレイスを登録（初回のみ）
/plugin install alfred                          # プラグインをインストール
```

プラグイン（skills, rules, hooks, agents, MCP 設定）が配置される。

### 3. API キーを設定

```bash
export VOYAGE_API_KEY=your-key  # ~/.zshrc 等に追加
```

セマンティック検索に [Voyage AI](https://voyageai.com/) を使用する。

### 4. 知識ベースを初期化

```bash
alfred init
```

公式ドキュメント（1,400+ 件）を SQLite に取り込み、Voyage AI で embedding を生成する。TUI で進捗を表示する。

Claude Code を再起動すれば完了。

## アップデート

### 1. プラグインを更新

Claude Code 内で

```
/plugin update alfred
```

### 2. バイナリを更新

Claude Code を終了し、ターミナルで

```bash
brew upgrade hir4ta/alfred/alfred
```

### 3. Claude Code を再起動

更新完了。

## スキル (6)

Claude Code 内で `/alfred:<スキル名>` で呼び出す。

| スキル | 内容 |
|--------|------|
| `/alfred:configure <種類> [名前]` | 単一の設定ファイルを作成・更新（skill, rule, hook, agent, MCP, CLAUDE.md, memory）+ 独立レビュー |
| `/alfred:setup` | プロジェクト全体のセットアップウィザード — 複数ファイルのスキャン+設定、または Claude Code 機能の解説 |
| `/alfred:brainstorm <テーマ>` | 発散（ブレスト）— 観点・選択肢・仮説・質問を増やす |
| `/alfred:refine <テーマ>` | 壁打ち（収束）— 論点を固定し、選択肢を絞り、決定を出す |
| `/alfred:plan <task-slug>` | Alfred Protocol — 対話的に spec を生成し、Compact/セッション喪失に強い開発計画を作成 |
| `/alfred:review [focus]` | 3層ナレッジ活用コードレビュー（spec + ナレッジ + ベストプラクティス） |

## エージェント (1)

| エージェント | 内容 |
|------------|------|
| `alfred` | Claude Code の設定・ベストプラクティスに関するサポート |

## MCP ツール (9)

スキルとエージェントのバックエンド。Claude が必要に応じて自動的に呼び出すため、直接呼ぶ必要はない。

| ツール | 内容 |
|--------|------|
| `knowledge` | ハイブリッド vector + FTS5 + Voyage rerank によるドキュメント検索 |
| `config-review` | プロジェクトの .claude/ 設定を深堀り分析（ファイル内容読み込み + KB 照合） |
| `spec` | 統合 spec 管理（action: init / update / status / switch / delete） |

## Hook (4)

Claude Code のライフサイクルに応じて自動実行される。ユーザーが意識する必要はない。

| イベント | 動作 |
|----------|------|
| SessionStart | CLAUDE.md 自動取り込み + spec コンテキスト注入（adaptive 復帰） |
| PreCompact | transcript からコンテキスト抽出 + 決定自動検出 + 変更ファイル追跡 → session.md を activeContext 形式で保存 → compaction instructions 出力 → 非同期 embedding 生成 |
| PreToolUse | `.claude/` 設定ファイルへのアクセス時に alfred ツール利用リマインダー |
| UserPromptSubmit | キーワードゲート付き FTS ナレッジ注入 — Claude Code 関連トピックのベストプラクティスを自動提供 |

## コマンド

| コマンド | 内容 |
|----------|------|
| `init` | 知識ベース初期化（TUI 進捗表示、seed + embedding 生成） |
| `update` | 最新バージョンに更新（Homebrew / ダウンロード / go install） |
| `pane <type>` | モニタリングペイン（`spec` / `decisions` / `git`）Zellij レイアウト同梱 |
| `version` | バージョン表示 |

## 仕組み

```
┌──────────────────────────────────────────────────┐
│              Claude Code セッション                │
│                                                  │
│  Hook (自動)                                      │
│  ├ SessionStart → CLAUDE.md 取り込み              │
│  │                + spec context 注入             │
│  ├ PreCompact  → session.md 自動保存             │
│  │               (決定検出 + 変更ファイル追跡)      │
│  │               + compaction instructions        │
│  │               + async embedding                │
│  ├ PreToolUse  → .claude/ アクセスリマインダー     │
│  └ UserPromptSubmit → keyword filter + FTS 注入    │
│                                                  │
│  MCP ツール (必要時)                               │
│  ├ knowledge / config-review                      │
│  └ spec (init/update/status/switch/delete)         │
│                                                  │
│  Alfred Protocol フロー                           │
│  spec(init) → .alfred/specs/add-auth/             │
│  (4 ファイル生成 + DB 同期)                        │
│        ↓                                         │
│  Compact 発生 → PreCompact が自動保存             │
│  (transcript 抽出 + 決定検出                       │
│   + git 変更ファイル → activeContext 形式)          │
│        ↓                                         │
│  SessionStart(compact) → adaptive 復帰            │
│  (初回: 全4ファイル / 2回目〜: session.md のみ)     │
└──────────────────────────────────────────────────┘
```

### Alfred Protocol のファイル構成

```
.alfred/specs/{task-slug}/
├── requirements.md  # 要件・成功条件・スコープ外
├── design.md        # 設計・アーキテクチャ
├── decisions.md     # 設計決定と代替案・理由の記録
└── session.md       # activeContext 形式のセッション状態 + Compact Marker
```

`_active.md` (YAML) で複数タスクを管理し、`spec` (action=switch) で切替可能。

## デバッグ

`ALFRED_DEBUG=1` を設定すると `~/.claude-alfred/debug.log` にデバッグログを出力する。

## 依存ライブラリ

| ライブラリ | 用途 |
|-----------|------|
| [mcp-go](https://github.com/mark3labs/mcp-go) | MCP サーバー SDK |
| [go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite ドライバ（pure Go, WASM） |
| [bubbletea](https://github.com/charmbracelet/bubbletea) | TUI フレームワーク（setup 画面） |
| [Voyage AI](https://voyageai.com/) | embedding + rerank（voyage-4-large, 2048d） |

## ライセンス

MIT
