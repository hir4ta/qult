# alfred

[![Version](https://img.shields.io/npm/v/claude-alfred)](https://www.npmjs.com/package/claude-alfred)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/github/license/hir4ta/claude-alfred)](https://github.com/hir4ta/claude-alfred/blob/main/LICENSE)

Claude Code の開発執事。

[English README](README.md)

## 何が辛いのか

Claude Code で開発してると、3つの壁にぶつかる。

**忘れる。** Compact するたび、セッション切れるたび、全部消える。20分かけた設計判断、もう一回聞かれる。

**行き当たりばったり。** 仕様もなく、計画もなく、ノリで実装。動くけど、壊れる。

**誰もレビューしない。** コードがそのまま出ていく。バグは本番で見つかる。

alfred は3つとも潰す。

## アプローチ

alfred は**仕様駆動の開発フロー**を強制する。全タスクが同じ構造に従う。例外はない。

```
Spec > Wave > Task
```

**Spec** はこれから作るものを記述するドキュメント群。**Wave** は関連タスクをレビュー可能な塊にまとめたもの。**Task** は1つの作業単位。

フローはこう進む。

1. **Spec を作る** — 要件、設計、タスク、テスト仕様
2. **セルフレビュー** — 3つの AI エージェントがアーキテクチャを議論する（S サイズ含む全サイズ）
3. **承認を得る** — ブラウザダッシュボードでレビュー、任意の行にコメント（M/L/XL）
4. **Wave ごとに実装** — 各 Wave 完了後にコミット、セルフレビュー、学びを保存
5. **クローズ** — 最終レビューして `dossier complete`

これは提案じゃない。Hook が強制する。Spec なしでコードを書こうとするとブロックされる。Wave レビューをスキップすると Edit/Write が使えなくなる。

## 何ができるか

### 消えない仕様

要件、設計、タスク、テスト仕様 — 構造化された Markdown が Compact を跨いで生き残る。コンテキストは失われない。タスクの大きさに合わせてファイル数が変わる。バグ修正なら2ファイル、大規模機能なら5ファイル。

### 積み重なる記憶

「あの時こう決めた」「このバグ前にも見た」「X は試したけどダメだった」— 全てが `.alfred/knowledge/` に構造化 JSON として保存される。3分類のみ: **decision**、**pattern**、**rule**。Git フレンドリーで、チームで共有できる。矛盾は自動検出。次に似た問題に当たったとき、聞く前に alfred が出してくる。

### ドリフトしない仕様

コミットの度に、変更ファイルを Spec と照合。設計書にないコンポーネントを変更した？ 警告。メモリに保存した規約がコードと合わなくなった？ フラグ。

### スケールするレビュー

6つのレビュープロファイル（code, config, security, docs, architecture, testing）、それぞれにチェックリスト。並列エージェント、スコア付きレポート、具体的な修正案。

### バイパスできない承認ゲート

3層の enforcement で守る。
- **Review gate** が spec/wave レビュー完了まで Edit/Write をブロック
- **Approval gate** が未承認 M/L/XL をブロック
- **Intent guard** が spec なし実装をブロック

ステータスの手動書き換えでは突破できない。レビュー JSON ファイルの存在も検証する。

### 能動的スキル提案

調査中か、実装中か、バグ修正中か、PR マージ直後か、大きな PDF を読んでいるか — alfred が状況を検知して、適切なスキルを提案する。コマンドを覚える必要はない。

### 日英切り替え対応のダッシュボード

`localhost:7575` でリアルタイムにプロジェクト状態を確認。タスク進捗、ナレッジ健全性、アクティビティ。ワンクリックで日本語・英語を切り替え。設定はブラウザに保存される。

## セットアップ

### 1. インストール

```bash
npm install -g claude-alfred
```

SQLite データベースとユーザールールが自動セットアップされる。`alfred doctor` で確認。

### 2. プラグイン

Claude Code 内で:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred
```

### 3. 環境変数

`~/.zshrc` に追加:

```bash
export VOYAGE_API_KEY=your-key  # セマンティック検索が有効に（1セッション約$0.01）
export ALFRED_LANG=ja           # 出力言語 (en/ja/zh/ko/fr/de/es/pt...)
```

Voyage のキーがなくても動く。FTS5 全文検索がフォールバックする。

### 4. プロジェクトセットアップ

Claude Code 内で、プロジェクトルートから:

```
/init    <- 候補から "alfred" を選択
```

ステアリングドキュメント、テンプレート、ナレッジインデックスを生成する。

> **注意**: `/alfred:init` ではなく `/init` (短縮形) を使うこと。Claude Code の補完が `alfred:` プレフィックスを別スキルに誤ルーティングする場合がある。全スキル共通で `/brief`, `/attend`, `/mend` のように短縮形を推奨。

## アップデート

両方を一緒に更新する。

```bash
npm update -g claude-alfred        # CLI、hooks、MCP サーバー、ダッシュボード
```

```
/plugin update alfred              # skills、agents、rules（Claude Code 内で）
```

`alfred doctor` でバージョンの一致を確認できる。

## スキル

### コアワークフロー

| スキル | やること |
|--------|----------|
| `/alfred:brief` | Spec を生成。3エージェントがアーキテクチャを議論し、ダッシュボードで承認する |
| `/alfred:attend` | 全自動。Spec 作成 → 承認ゲート → Wave ごとの実装 → レビュー → コミットまで放置でOK |
| `/alfred:tdd` | テスト駆動開発。red → green → refactor のサイクルを自律的に回す |
| `/alfred:mend` | バグ修正。再現 → 原因特定（過去バグの記憶も使う）→ 修正 → 検証 → コミット |
| `/alfred:inspect` | 6プロファイル並列レビュー（code, config, security, docs, architecture, testing）。スコア付き |

### 探索と設計

| スキル | やること |
|--------|----------|
| `/alfred:survey` | 既存コードから Spec をリバースエンジニアリング。信頼度スコア付き |
| `/alfred:salon` | ブレスト。3人の専門家が並列でアイデアを出して、トレードオフを議論する |
| `/alfred:harvest` | PR レビューコメントからナレッジを抽出して永続メモリに保存 |
| `/alfred:archive` | 参照資料（PDF, CSV, 大きなテキスト）を検索可能なナレッジに変換 |

### セットアップと保守

| スキル | やること |
|--------|----------|
| `/alfred:init` | プロジェクト初期化。マルチエージェントでコードベースを探索し、ステアリングドキュメントを生成 |

## MCP ツール

| ツール | 役割 |
|--------|------|
| `dossier` | Spec のライフサイクル管理 — init, update, status, switch, complete, delete, history, rollback, review, validate, gate, defer, cancel |
| `roster` | エピック管理 — タスクのグループ化、依存関係、Spec 横断の進捗追跡 |
| `ledger` | ナレッジ — search, save (decision/pattern/rule), promote (pattern → rule), reflect, audit-conventions |

## Hook

全自動。触らなくていい。

| イベント | 動作 |
|----------|------|
| SessionStart | Spec コンテキスト復元、ナレッジ同期、セットアップ提案（`/alfred:init`） |
| UserPromptSubmit | セマンティック検索 + スキル提案 + Spec enforcement（Spec なし実装ブロック、未承認 M/L/XL ブロック） |
| PreToolUse | 3層 enforcement — review gate, intent guard, approval gate。ゲートが有効な間は Edit/Write をブロック |
| PostToolUse | tasks.md の進捗自動更新。タスクステータス自動遷移 (pending→in-progress→review)。Wave 完了検知とレビューゲート設定。コミット後のドリフト検出。PR マージ後の `/alfred:harvest` 提案、大きな参照ファイル読み込み時の `/alfred:archive` 提案 |
| PreCompact | セッションスナップショット保存、決定抽出、エピック進捗同期 |
| Stop | review gate → ブロック。その他 → コンテキストリマインド（ブロックなし） |

## ブラウザダッシュボード

```bash
alfred dashboard              # ブラウザで localhost:7575 を開く
alfred dashboard --port 8080  # ポート指定
alfred dashboard --url-only   # URLだけ出力
```

4つのタブ: **Overview**（プロジェクト健全性、タスク進捗、メモリ統計）、**Tasks**（Spec の詳細表示、折りたたみセクション、インラインレビュー）、**Knowledge**（メモリの検索・閲覧、有効/無効切り替え）、**Activity**（操作タイムラインとフィルタ）。

**日本語/英語のワンクリック切り替え**対応。設定はセッションを跨いで保持。

着手中のタスクがシマーで光る。何が進行中か、一目でわかる。

開発用: `ALFRED_DEV=1 alfred dashboard` + `task dev`（web/ 内）で Vite HMR が使える。

## Steering 文書

プロジェクトレベルのコンテキストを全 Spec に注入する。

```bash
/alfred:init
```

`.alfred/steering/` に3ファイルを作成する。
- `product.md` — プロジェクトの目的、対象ユーザー、スコープ境界
- `structure.md` — パッケージ構成、モジュール境界、命名規約
- `tech.md` — 技術スタック、依存関係、アーキテクチャ判断

3ファイル全てが `dossier init` 時に読み込まれ、コンテキストとして注入される。AI は常にアーキテクチャを理解している。

## 検索パイプライン

3段階で、順にフォールバックする。

1. **Voyage AI ベクトル検索** + リランキング（API キーがあるとき）
2. **FTS5 全文検索** — タグエイリアス展開 + ファジーマッチ付き
3. **キーワードフォールバック**（LIKE クエリ）

タグエイリアスが検索を自動拡張する。「auth」で「authentication」「login」「認証」もヒット。ファジーマッチがタイポを吸収する。

## ナレッジアーキテクチャ

ナレッジはプロジェクトディレクトリ内の構造化 JSON ファイル。3分類、曖昧さゼロ。

```
.alfred/knowledge/
├── decisions/    # 一回きりの選択 + 理由 + 却下した代替案
├── patterns/     # 繰り返し実践 + 適用条件 + 期待結果
└── rules/        # 強制ルール + 優先度 + 根拠
```

スキーマは厳密（[mneme](https://github.com/hir4ta/mneme) 互換）。テンプレート化されたパラメータで保存するので、セッション間のフォーマット揺れはゼロ。

Git フレンドリー（コミットしてチームと共有、PR でレビュー）。アトミック書き込み（temp + rename）。再構築可能（SQLite インデックスを消しても次のセッションで再生成）。パターンは検索ヒット15回以上でルールに自動昇格。矛盾は自動検出。

## 適応的スペック

全タスクに6ファイルは要らない。

| サイズ | ファイル数 | 用途 |
|--------|-----------|------|
| **S** | 2 (requirements, tasks) | バグ修正、設定変更、小さな変更 |
| **M** | 4 (+ design, test-specs) | 新エンドポイント、リファクタ、中規模機能 |
| **L/XL** | 5 (+ research) | アーキテクチャ変更、新サブシステム |
| **D** (delta) | 1 (delta.md) | 既存コードへのブラウンフィールド変更 |
| **Bugfix** | 2-3 (bugfix.md, tasks, +test-specs) | 再現手順付きバグ修正 |

サイズは説明文から自動判定、または `dossier action=init size=S` で明示指定。

## 仕組み

```
あなた
  |
  |-- /alfred:brief    -> Spec + 3エージェント議論 + ダッシュボード承認
  |-- /alfred:attend   -> Spec → 承認 → 実装（Wave ごと）→ レビュー → コミット
  |-- /alfred:mend     -> 再現 → 原因分析（+ 過去バグ記憶）→ 修正 → 検証
  |
  v
Hook（見えない）
  |-- SessionStart     -> コンテキスト復元、ナレッジ同期、セットアップ提案
  |-- UserPromptSubmit -> ベクトル検索 + スキル提案 + Spec enforcement
  |-- PreToolUse       -> review gate + intent guard + approval gate（3層）
  |-- PostToolUse      -> 進捗自動更新、Wave ゲート、ドリフト検出
  |-- PreCompact       -> スナップショット、決定抽出、エピック進捗
  |-- Stop             -> review gate ブロック + リマインド
  |
  v
ストレージ
  |-- .alfred/knowledge/   -> JSON（decisions/, patterns/, rules/）— 真のソース
  |-- .alfred/specs/       -> Spec ファイル + バージョン履歴 + レビュー
  |-- .alfred/epics/       -> エピック YAML + タスク依存関係
  |-- .alfred/steering/    -> プロジェクトコンテキスト（product, structure, tech）
  +-- ~/.claude-alfred/    -> SQLite 検索インデックス（再構築可能）
```

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| メモリ検索で結果が出ない | `VOYAGE_API_KEY` を設定、または FTS5 フォールバックの動作確認 |
| 出力が意図しない言語 | `ALFRED_LANG=ja`（または `en`, `zh` 等）を `~/.zshrc` に追加 |
| Hook が動かない | `/plugin install alfred` して Claude Code を再起動 |
| ダッシュボードが空 | `.alfred/specs/` があるディレクトリで `alfred dashboard` を実行 |
| レート制限エラー | 対策済み。エージェントは段階的バッチ起動（最大2並列） |

## ライセンス

MIT
