# alfred

[![Version](https://img.shields.io/npm/v/claude-alfred)](https://www.npmjs.com/package/claude-alfred)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/github/license/hir4ta/claude-alfred)](https://github.com/hir4ta/claude-alfred/blob/main/LICENSE)

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) の開発執事。仕様、記憶、レビュー — 全部自動。

**他のツールは提案する。alfred は強制する。**

[English README](README.md)

## 30秒で分かる alfred

```
あなた: 「ユーザー認証を追加して」

alfred: spec を作成（要件 + 設計 + タスク）→
        3つのエージェントがアーキテクチャを議論 →
        ブラウザダッシュボードで承認 →
        Wave ごとに実装、都度コミット＋レビュー →
        学んだことを次回のために保存
```

何を作るか言うだけ。あとは alfred がやる。

## はじめる

```bash
npm install -g claude-alfred
```

Claude Code で:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred
/init    # "alfred" を選択 — ステアリングドキュメント + ナレッジインデックスをセットアップ
```

任意: `~/.zshrc` に `export VOYAGE_API_KEY=your-key` を追加するとセマンティック検索が有効に（1セッション約$0.01）。なくても FTS5 全文検索で動く。

## 何が違うのか

多くの spec ツールは「先に仕様を書いた方がいいですよ」と slash command で提案する。alfred は Claude Code の Hook システムで Edit/Write を**物理的にブロック**する。提案ではなく、ツールレベルでの強制 — それが根本的な違い。

**提案ではなく強制。** 3層のゲートがコード編集を制御する。spec なしの実装を防ぐインテントガード。前の Wave をレビューするまで次を止めるレビューゲート。ダッシュボードで人間が承認するまで M/L の実装を止める承認ゲート。YAML を手で書き換えてもダメ — 署名済みレビューファイルまで検証する。

**記憶が育つ。** 「あの時なぜこう決めた」「このパターンは前もうまくいった」「X は試してダメだった」— `.alfred/knowledge/` に JSON で残る。15回以上検索ヒットしたパターンはルールに自動昇格。知識タイプごとに半減期が違う — ルールは120日、仮定は30日で鮮度が落ちる。Git に入れてチームで共有できる。次に似た状況が来たら、聞く前に出てくる。

**仕様がズレたら教えてくれる。** コミットの度に変更を設計ドキュメントと照合。spec にないコンポーネントを触ったら警告が飛ぶ。新しいソースファイルは該当コンポーネントのセクションに自動追記 — 手動で spec を更新する必要はない。

**コンテキストが適応する。** プロジェクトの成熟度に応じて注入量を調整する。新しいプロジェクトにはセッション開始時に spec 全体を注入。20件以上のナレッジがあるプロジェクトには現在のタスクとゴールだけ — コンテキストを膨らませない。

**スキルが勝手に出てくる。** 調べものしてたら `/brief` を提案。バグ直してたら `/mend`。覚えなくていい — 意図をセマンティック or キーワードで分類（日英バイリンガル）して、適切なスキルを出す。

**ダッシュボードが使える。** `alfred dashboard` で `localhost:7575` が開く。タスク進捗、行レベルコメント付きレビュー、ファイル単位の承認、ナレッジの健全性、操作履歴。プロジェクト横断ビュー + `Cmd+K` グローバル検索。日英ワンクリック切替。

**プロジェクト横断インテリジェンス。** alfred は全プロジェクトを横断して見る。プロジェクト間の矛盾する設計判断？自動検出。新しい認証機能を始める？他プロジェクトの過去の判断が聞く前に出てくる。3つ以上のプロジェクトに共通するパターンは自動的に検出・昇格。

**git でチーム共有。** ナレッジは構造化 JSON — コミットして PR でレビューしてチームで共有。サーバー不要 — git がトランスポート。

## 2026年に alfred が必要な理由

Claude Code は強力だが、構造なき AI コーディングには既知の問題がある:

- **初回成功率 ~30%** — spec による文脈がないと、Claude は完了を偽装し、エッジケースを飛ばし、「終わった」と言い張る。alfred の3層ゲート（spec → review → approval）がコードベースに到達する前にキャッチする。
- **セッション間のコンテキスト喪失** — 1M context（Opus 4.6）でも compact は発火する。alfred は決定・パターン・進捗を構造化 JSON で永続化。compact、セッション境界、モデル切替を超えて生存する。
- **無限リファクタリングループ** — bounded iteration がないと Claude は同じコードを何時間も書き直す。alfred の Wave ベース実装が commit → review → advance を強制。Wave あたり最大2回の fix ラウンド、超えたらエスカレート。
- **セキュリティ盲点** — AI 生成コードの45%に脆弱性（業界調査）。alfred は Wave 境界ごとに並列コードレビューエージェントを起動、セキュリティは専用のレビュー視点。
- **仕様と実装のドリフト** — 実装が始まった瞬間に仕様は古くなる。alfred の Living Spec が毎コミットで変更ファイルを design.md に自動追記。仕様が自動で正直になる。

### SDD と IDD の融合

業界は **Spec-Driven Development**（構造化仕様）と **Intent-Driven Development**（Why と What だけ、How は AI 任せ）の2つに収束しつつある。alfred は両方を橋渡し:

- **フル SDD** — M/L 機能向け。要件、設計、タスク、テスト、トレーサビリティ、レビューゲート
- **軽量 IDD** — S/D 変更向け。要件 + 判断記録のみ、設計のオーバーヘッドなし
- **不変の判断記録** — `ledger save` で ADR ライクな意思決定を保存。プロジェクト・セッションを超えてセマンティック検索可能

### 1M context 時代の設計

Opus 4.6 の 1M context で compact は稀になったが、発火時の破壊力は5倍。alfred はこの現実に対応:

- **PreCompact hook** が構造化チャプターメモリ（ゴール、判断、サマリー）をコンテキスト消失前にキャプチャ
- **Knowledge 永続化**（`.alfred/knowledge/`）が compact、セッション再起動、モデル切替を確実に生き延びるデータ層
- **適応的注入** — 新プロジェクトにはフルコンテキスト、成熟プロジェクトには現タスクのみ。コンテキスト肥大化なし

## スキル

| スキル | ひとこと |
|--------|----------|
| `/alfred:attend` | 全自動。spec → 承認 → 実装 → レビュー → コミット。放置でOK |
| `/alfred:brief` | spec を生成。3エージェントがアーキテクチャを議論、ダッシュボードで承認 |
| `/alfred:mend` | バグ修正。再現 → 原因特定（過去バグの記憶も使う）→ 修正 → 検証 |
| `/alfred:tdd` | テスト駆動。red → green → refactor。パターンをセッション越しに記憶 |
| `/alfred:inspect` | 6プロファイル並列レビュー。スコア付き |
| `/alfred:survey` | 既存コードから spec をリバースエンジニアリング。信頼度スコア付き |
| `/alfred:salon` | ブレスト。3人の専門家が並列で出して、トレードオフを議論 |
| `/alfred:archive` | 参照資料（PDF, CSV, 大きなテキスト）を検索可能なナレッジに変換 |
| `/alfred:init` | プロジェクト初期化。マルチエージェントで探索 → ステアリングドキュメント生成 |

## 仕組み

```
あなた
  |-- /alfred:brief    -> spec + 3エージェント議論 + ダッシュボード承認
  |-- /alfred:attend   -> spec → 承認 → 実装（Wave ごと）→ レビュー → コミット
  |-- /alfred:mend     -> 再現 → 原因分析（+ 過去バグ記憶）→ 修正 → 検証
  v
Hook（見えない）
  |-- SessionStart     -> コンテキスト復元、ナレッジ同期
  |-- UserPromptSubmit -> セマンティック検索 + スキル提案 + spec enforcement
  |-- PreToolUse       -> review gate + intent guard + approval gate（3層）
  |-- PostToolUse      -> 進捗自動更新、ステータス自動遷移、ドリフト検出
  |-- PreCompact       -> タスクスナップショット、決定抽出
  |-- Stop             -> review gate ブロック + リマインド
  v
ストレージ
  |-- .alfred/knowledge/   -> JSON（decisions/, patterns/, rules/）— ソースオブトゥルース
  |-- .alfred/specs/       -> spec ファイル + バージョン履歴 + レビュー
  |-- .alfred/steering/    -> プロジェクトコンテキスト（product, structure, tech）
  +-- ~/.claude-alfred/    -> SQLite 検索インデックス + 監査ログ（再構築可能）
```

## MCP ツール

| ツール | 管理対象 |
|--------|----------|
| `dossier` | spec ライフサイクル — init, update, complete, defer, cancel, review, gate など |
| `ledger` | ナレッジ — 検索、保存、パターン → ルール昇格、ヘルスレポート |

## ナレッジ

JSON ファイルとして Git にコミットし、PR でレビューし、チームで共有できる。

```
.alfred/knowledge/
  decisions/    # 「X を選んだ。理由は Y。Z は却下」
  patterns/     # 「A のとき B をやる。C が期待結果」
  rules/        # 「常に X する。優先度: P0。根拠: Y」
```

15回以上検索ヒットしたパターンはルールに自動昇格。

各エントリに作成者（`git user.name`）を自動記録。`alfred knowledge export/import` でプロジェクト間のナレッジ移動も可能。

検索パイプライン: Voyage AI ベクトル + リランキング > FTS5 ファジーマッチ > キーワードフォールバック。「auth」で「authentication」「login」「認証」もヒット。

## spec サイズ

| サイズ | ファイル数 | 用途 |
|--------|-----------|------|
| **S** | 3 | バグ修正、小さな機能 |
| **M** | 4 | 新エンドポイント、リファクタ |
| **L** | 5 | アーキテクチャ変更、新サブシステム |

## アップデート

```bash
npm install -g claude-alfred        # CLI、hooks、MCP サーバー、ダッシュボード
```

```
/plugin update alfred              # skills、agents、rules（Claude Code 内で）
```

`alfred doctor` で同期を確認。

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| メモリ検索で結果が出ない | `VOYAGE_API_KEY` を設定、または FTS5 の動作確認 |
| 意図しない言語 | `export ALFRED_LANG=ja` を `~/.zshrc` に追加 |
| Hook が動かない | `/plugin install alfred` して Claude Code を再起動 |
| ダッシュボードが空 | `.alfred/specs/` があるディレクトリで実行。任意ディレクトリでも横断ビューで起動可 |

## アンインストール

Claude Code で:

```
/plugin    # alfred を選択 → marketplace から削除（プラグインも一緒に消える）
```

```bash
npm uninstall -g claude-alfred
rm -rf ~/.claude-alfred/                          # SQLite 検索インデックス
rm -f ~/.claude/rules/alfred.md                   # ユーザールール
rm -rf ~/.claude/plugins/cache/claude-alfred/      # プラグインキャッシュ
rm -rf .alfred/                                    # プロジェクトの spec、ナレッジ、ステアリング（プロジェクトごと）
```

## ライセンス

MIT
