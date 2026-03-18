# alfred

[![Version](https://img.shields.io/npm/v/claude-alfred)](https://www.npmjs.com/package/claude-alfred)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
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

**適応する仕様。** 小さなバグ修正なら3ファイル。中規模なら5。大規模なら6。タスクに応じてスペックの深さを自動調整。bugfix専用テンプレート（再現手順、原因分析、修正戦略）も。

**積み重なる記憶。** 「あの時こう決めた」「このバグ前にも見た」「Xは試したけどダメだった」— 全てが `.alfred/knowledge/` に構造化JSONとして保存される。3分類のみ: **decision**（一回きりの選択 + 理由 + 却下した代替案）、**pattern**（繰り返し実践 + 適用条件 + 期待結果）、**rule**（強制ルール + 優先度 + 根拠）。Git フレンドリーで、チームで共有できる。SQLite検索インデックスがセマンティック検索を提供。矛盾は自動検出。次に似た問題に当たったとき、聞く前に alfred が出してくる。

**信頼性シグナル。** 仕様の全項目にgrounding level（`verified`/`reviewed`/`inferred`/`speculative`）が付く。どの要件が実証済みで、どれが推測なのか一目でわかる。typoも検出する。

**ブラウンフィールド対応。** 既存コード変更用のdelta specに`CHG-N`変更IDとBefore/After行動差分を追加。「どのファイルが変わった」だけでなく「どの振る舞いがなぜ変わった」まで追跡。3つの新バリデーションチェック付き。

**ドリフトしない仕様。** コミットの度に、変更ファイルをスペックと照合。設計書にないコンポーネントを変更した？警告。メモリに保存したコーディング規約がコードと合わなくなった？フラグ。これをやるツールは他にない。

**スケールするレビュー。** 6つのレビュープロファイル（code, config, security, docs, architecture, testing）、それぞれにチェックリスト。並列エージェント、スコア付きレポート、具体的な修正案。

**能動的スキル提案。** alfred は呼ばれるのを待たない。調査中か、設計中か、実装中か、バグ修正中かを検出し、適切なタイミングで適切なスキルを提案する。コードを探索し続けてる？「`/alfred:survey` 使ったら？」。調査結果が出た？「`ledger` に保存しよう」。タスクが溜まってきた？「`roster` でまとめよう」。

**バイパスできない承認ゲート。** 実装前に仕様のレビューサイクルを回す。ブラウザダッシュボードで任意の行にコメントして、承認か差し戻し — GitHub の PR レビューと同じ体験を、仕様に対してやる。ステータスの手動書き換えでは突破できない。**3層 enforcement**: (1) review gate が spec/wave レビュー完了まで Edit/Write をブロック、(2) approval gate が未承認 M/L/XL をブロック、(3) intent guard が spec なし実装をブロック。Stop hook はレビューゲート以外ではブロックせず、リマインドのみ。

**リアルタイムナレッジ抽出。** `ledger` で保存した decision は即座に検索可能。設計パターンは spec 更新時に自動抽出。レビューエージェントの指摘（critical/high）はアンチパターンとして自動保存。ナレッジはタスク完了時だけでなく、継続的に蓄積される。

**張り付くプロジェクトコンテキスト。** Steering文書（プロダクトの目的、コード構造、技術スタック）がプロジェクトから自動生成され、すべての仕様に注入される。AIは常にアーキテクチャを理解している。

## セットアップ

### 1. インストール

```bash
npm install -g claude-alfred
```

SQLite データベースとユーザールールが自動セットアップされる。確認:

```bash
alfred doctor
```

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
/init    ← 候補から "alfred" を選択
```

ステアリングドキュメント、テンプレート、ナレッジインデックスを生成する。

> **注意**: `/alfred:init` ではなく `/init` (短縮形) を使うこと。Claude Code の補完が `alfred:` プレフィックスを別スキルに誤ルーティングする場合がある。全 alfred スキル共通: `/brief`, `/attend`, `/mend` のように短縮形を推奨。

## アップデート

両方を一緒に更新する:

```bash
npm update -g claude-alfred        # CLI、hooks、MCP サーバー、ダッシュボード
```

```
/plugin update alfred              # skills、agents、rules（Claude Code 内で）
```

`alfred doctor` でバージョンの一致を確認できる。

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
| `dossier` | 仕様のライフサイクル管理 — init, update, status, switch, complete, delete, history, rollback, review, validate, gate（レビューゲート管理） |
| `roster` | エピック管理 — タスクのグループ化、依存関係、進捗追跡 |
| `ledger` | ナレッジ — search, save（構造化JSON: decision/pattern/rule）, promote（pattern→rule）, reflect, audit-conventions |

## Hook

全自動。触らなくていい。

| イベント | 動作 |
|----------|------|
| SessionStart | 仕様コンテキスト復元 + ナレッジ同期 + 1%ルール（スキル発動促進）+ 成熟度適応 |
| PreCompact | スナップショット保存 + 決定抽出 + エピック進捗同期 + 調査パターン検出 |
| UserPromptSubmit | セマンティック検索 + スキルナッジ + **spec承認ゲート**（未承認 M/L/XL に DIRECTIVE） |
| PostToolUse | エラー検出 + Next Steps 自動チェック + ドリフト検出 + コミット時決定保存 |
| **PreToolUse** | **3層 enforcement**: (1) review gate（spec/wave レビュー完了まで）、(2) intent guard（spec なし実装ブロック）、(3) approval gate（未承認 M/L/XL）。`.alfred/` 編集は常に許可 |
| **Stop** | review gate → ブロック。その他 → コンテキストリマインド（ブロックなし） |

## ブラウザダッシュボード

```bash
alfred dashboard              # ブラウザで localhost:7575 を開く
alfred dashboard --port 8080  # ポート指定
alfred dashboard --url-only   # URLだけ出力
```

| タブ | 表示内容 |
|------|----------|
| **Overview** | プロジェクトの健康状態 — タスク進捗とバリデーション結果、メモリ健康度（陳腐化数・矛盾数）、仕様の信頼度分布、エピック進捗、最近の意思決定 |
| **Tasks** | Active/Completed セクション分離。タスクをクリックで2カラム詳細ビュー: 左にメタデータ、右に折りたたみ可能なspecセクション（色分け付き）。Review タブでインラインコメント |
| **Knowledge** | メモリ一覧（サブタイプ別タグ付き）。セマンティック検索（Voyage AI、300msデバウンス）。ローカルテキストフィルタ。メモリの有効/無効切り替え |
| **Activity** | 操作タイムライン。イベントタイプ別フィルタ（init/complete/review）。エピックドリルダウン |

インラインレビュー: 仕様ファイルを選択し、Review タブに切り替え。特定の行にコメントして、レビューラウンドを切り替えて、承認または差し戻し — ブラウザで完結。

着手中のタスクがシマーで光る。何が進行中か、一目でわかる。

開発用: `ALFRED_DEV=1 alfred dashboard` + `task dev`（web/ 内）で Vite HMR が使える。

## 検索パイプライン

キーワードマッチだけじゃない。3段階の検索パイプライン:

1. **Voyage AI ベクトル検索** + リランキング（API キーがあるとき）
2. **FTS5 全文検索** — タグエイリアス展開 + ファジーマッチ付き
3. **キーワードフォールバック**（LIKE クエリ）

タグエイリアスが検索を自動拡張する: 「auth」で「authentication」「login」「認証」もヒットする。

ファジーマッチがタイポを吸収する:「authetication」でも「authentication」が見つかる。

## ナレッジアーキテクチャ

ナレッジは構造化JSONファイルとして保存される。3分類、曖昧さゼロ。真のソースはプロジェクトディレクトリにあり、バイナリDBではない。

```
.alfred/knowledge/
├── decisions/
│   └── dec-auth-jwt.json        # 一回きりの選択 + 理由 + 却下した代替案
├── patterns/
│   └── pat-error-handling.json  # 繰り返し実践 + 適用条件 + 期待結果
└── rules/
    └── rule-no-mock-db.json     # 強制ルール + 優先度 + 根拠
```

各タイプには厳密なスキーマ（[mneme](https://github.com/hir4ta/mneme) 互換）:
- **Decision**: `title`, `decision`, `reasoning`, `alternatives[]`, `tags[]`, `status`
- **Pattern**: `type` (good/bad/error-solution), `context`, `pattern`, `applicationConditions`, `expectedOutcomes`
- **Rule**: `key`, `text`（命令形）, `category`, `priority` (p0/p1/p2), `rationale`, `sourceRef`

全エントリはテンプレート化されたパラメータで保存（フリーテキスト不可）— セッション間のフォーマット揺れゼロ。

- **Git フレンドリー**: ナレッジをコミットしてチームと共有、PRでレビュー
- **アトミック書き込み**: temp ファイル + rename でクラッシュ時の破損防止
- **再構築可能**: SQLite検索インデックスはこれらのファイルから派生 — DB を削除しても次のセッションで再構築される
- **サブタイプ減衰**: パターンは90日で減衰。実証されたルールは120日持つ。種類ごとに半減期が違う。
- **昇格**: パターンは検索ヒット15回以上でルールに自動昇格
- **矛盾検出**: 2つのエントリが矛盾していたら（「JWT使え」vs「JWT避けろ」）、自動でフラグ。
- **多言語対応**: `ALFRED_LANG` で保存されるナレッジの言語を制御

## 適応的スペック

全タスクに7ファイルは要らない。

| サイズ | 生成ファイル | 用途 |
|--------|------------|------|
| **S** | 3: requirements, tasks, session | バグ修正、設定変更、小さな変更 |
| **M** | 5: + design, test-specs | 新エンドポイント、リファクタ、中規模機能 |
| **L/XL** | 6: + research | アーキテクチャ変更、新サブシステム。Decision は `ledger` で直接保存 |
| **D** (delta) | 2: delta.md（CHG-N ID + Before/After付き）, session | 既存コードへのブラウンフィールド変更 |
| **Bugfix** | 3-4: bugfix.md, tasks, session (+test-specs) | 外科的バグ修正（再現手順付き） |

サイズは説明文から自動判定、または明示指定: `dossier action=init size=S`

## スペック検証

`dossier action=validate` で22項目の段階的チェック:

- 必須セクション（Goal、Functional Requirements 等）の存在
- サイズ別最小FR数（S: 1+, M: 3+, L: 5+）
- トレーサビリティ完全性（全FR→タスク、全タスク→FRの双方向）
- confidence + grounding annotation の存在
- Closing Wave の存在
- Grounding coverage — opt-in: speculative が30%超で失敗（L/XL）
- Delta spec品質 — Files Affected に CHG-N ID、Before/After セクションの実質的内容

## Steering 文書

プロジェクトレベルのコンテキストを全仕様に注入:

```bash
/alfred:init
```

`.alfred/steering/` に作成:
- `product.md` — プロジェクトの目的、対象ユーザー、ビジネスルール
- `structure.md` — パッケージ構成、モジュール境界、命名規約
- `tech.md` — 技術スタック、依存関係、API規約

`dossier init` 時に読み込まれ、コンテキストとして注入。仕様は常にプロジェクトを理解している。

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
  |-- SessionStart     -> コンテキスト復元、1%ルール、成熟度適応
  |-- PreCompact       -> スナップショット保存、決定抽出、エピック進捗
  |-- UserPromptSubmit -> ベクトル検索 + FTS5 + スキルナッジ + spec承認チェック
  |-- PostToolUse      -> エラー検出、Next Steps自動チェック、ドリフト検出
  |-- PreToolUse       -> review gate + intent guard + approval gate（3層 enforcement）
  |-- Stop             -> review gate ブロック + コンテキストリマインド（非ブロック）
  |
  v
ストレージ
  |-- .alfred/knowledge/   -> JSON（decisions/, patterns/, rules/）— 真のソース
  |-- .alfred/specs/       -> 仕様ファイル + バージョン履歴 + レビュー
  |-- .alfred/epics/       -> エピック YAML + タスク依存関係
  |-- .alfred/steering/    -> プロジェクトコンテキスト（product, structure, tech）
  |-- .alfred/templates/   -> ユーザーカスタマイズ可能な仕様・Steeringテンプレート
  +-- ~/.claude-alfred/    -> SQLite検索インデックス（knowledge_index + FTS5 + embeddings, スキーマ V8）
```

## ファイル生成タイミング

インストール時には何も生成されない。使うと出てくる:

| ファイル / ディレクトリ | 生成タイミング | トリガー |
|---|---|---|
| `~/.claude-alfred/alfred.db` | プラグインインストール後の最初の Claude Code セッション | SessionStart hook が DB を開く |
| `.alfred/knowledge/` | 最初のナレッジ保存時（decision, pattern, rule） | `ledger action=save`、PreCompact 決定抽出、spec complete |
| `.alfred/specs/` | 最初のタスク開始時 | `dossier action=init`（`/alfred:brief` や `/alfred:attend` 経由） |
| `.alfred/epics/` | 最初のエピック作成時 | `roster action=init` |
| `.alfred/steering/` | `/alfred:init` 実行時 | プロジェクト初期化スキル |
| `.alfred/templates/` | ユーザーが仕様・Steeringテンプレートをカスタマイズする時 | テンプレートオーバーライド用に手動作成 |
| `.alfred/.state/` | 最初のセッションローカル状態保存時 | ナッジ抑制カウント、探索カウンター（gitignore対象） |
| `.alfred/audit.jsonl` | 最初の仕様操作時またはコミット後ドリフト検出時 | `dossier init`、レビュー送信、PostToolUse ドリフト |

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| メモリ検索で結果が出ない | `export VOYAGE_API_KEY=your-key` — またはFTS5フォールバックの動作確認 |
| 出力が意図しない言語 | `export ALFRED_LANG=ja`（または `en`, `zh`, `ko` 等）を `~/.zshrc` に追加 |
| Hook が動かない | `/plugin install alfred` して再起動 |
| ダッシュボードが空 | `.alfred/specs/` があるディレクトリで `alfred dash` |
| レート制限エラー | 対策済み — エージェントは段階的バッチ起動（最大2並列） |

## ライセンス

MIT
