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

**提案ではなく強制。** 3層のゲートがコード編集を制御する。spec なしの実装を防ぐインテントガード。前の Wave をレビューするまで次を止めるレビューゲート。ダッシュボードで人間が承認するまで M/L/XL の実装を止める承認ゲート。YAML を手で書き換えてもダメ — 署名済みレビューファイルまで検証する。

**記憶が育つ。** 「あの時なぜこう決めた」「このパターンは前もうまくいった」「X は試してダメだった」— `.alfred/knowledge/` に JSON で残る。15回以上検索ヒットしたパターンはルールに自動昇格。知識タイプごとに半減期が違う — ルールは120日、仮定は30日で鮮度が落ちる。矛盾は自動検出。Git に入れてチームで共有できる。次に似た状況が来たら、聞く前に出てくる。

**仕様がズレたら教えてくれる。** コミットの度に変更を設計ドキュメントと照合。spec にないコンポーネントを触ったら警告が飛ぶ。新しいソースファイルは該当コンポーネントのセクションに自動追記 — 手動で spec を更新する必要はない。

**コンテキストが適応する。** プロジェクトの成熟度に応じて注入量を調整する。新しいプロジェクトにはセッション開始時に spec 全体を注入。20件以上のナレッジがあるプロジェクトには現在のタスクとゴールだけ — コンテキストを膨らませない。

**スキルが勝手に出てくる。** 調べものしてたら `/brief` を提案。バグ直してたら `/mend`。PR マージしたら `/harvest`。覚えなくていい — 意図をセマンティック or キーワードで分類（日英バイリンガル）して、適切なスキルを出す。

**ダッシュボードが使える。** `alfred dashboard` で `localhost:7575` が開く。タスク進捗、行レベルコメント付きレビュー、ファイル単位の承認、ナレッジの健全性、操作履歴。日英ワンクリック切替。

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
| `/alfred:harvest` | PR レビューコメントからナレッジを抽出して永続化 |
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
  |-- PreCompact       -> タスクスナップショット、決定抽出、エピック進捗
  |-- Stop             -> review gate ブロック + リマインド
  v
ストレージ
  |-- .alfred/knowledge/   -> JSON（decisions/, patterns/, rules/）— ソースオブトゥルース
  |-- .alfred/specs/       -> spec ファイル + バージョン履歴 + レビュー
  |-- .alfred/epics/       -> エピック YAML + 依存関係
  |-- .alfred/steering/    -> プロジェクトコンテキスト（product, structure, tech）
  +-- ~/.claude-alfred/    -> SQLite 検索インデックス（再構築可能）
```

## MCP ツール

| ツール | 管理対象 |
|--------|----------|
| `dossier` | spec ライフサイクル — init, update, complete, defer, cancel, review, gate など |
| `roster` | エピック — タスクのグループ化、依存関係、spec 横断の進捗追跡 |
| `ledger` | ナレッジ — 検索、保存、パターン → ルール昇格、ヘルスレポート |

## ナレッジ

JSON ファイルとして Git にコミットし、PR でレビューし、チームで共有できる。

```
.alfred/knowledge/
  decisions/    # 「X を選んだ。理由は Y。Z は却下」
  patterns/     # 「A のとき B をやる。C が期待結果」
  rules/        # 「常に X する。優先度: P0。根拠: Y」
```

スキーマ厳密（[mneme](https://github.com/hir4ta/mneme) 互換）。15回以上検索ヒットしたパターンはルールに自動昇格。矛盾は自動検出。

検索パイプライン: Voyage AI ベクトル + リランキング > FTS5 ファジーマッチ > キーワードフォールバック。「auth」で「authentication」「login」「認証」もヒット。

## spec サイズ

| サイズ | ファイル数 | 用途 |
|--------|-----------|------|
| **S** | 2 | バグ修正、設定変更 |
| **M** | 3-4 | 新エンドポイント、リファクタ |
| **L/XL** | 5 | アーキテクチャ変更、新サブシステム |
| **D** | 1 | 既存コードへの差分変更 |

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
| ダッシュボードが空 | `.alfred/specs/` があるディレクトリで実行 |

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
