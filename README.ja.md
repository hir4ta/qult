# qult

![Version](https://img.shields.io/badge/version-0.20.0-7fbbb3?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-standalone_binary-a7c080?style=flat-square&logo=typescript&logoColor=d3c6aa)
![Hooks](https://img.shields.io/badge/hooks-7-dbbc7f?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-0-83c092?style=flat-square)

**Quality by Structure, Not by Promise.** コードの品質を壁で守る evaluator harness。

> Claude は優秀だが、lint エラーを放置して次のファイルに行く。テストなしでコミットする。自分のコードを褒めてレビューを終える。
> qult は 7 hooks + MCP server + 3段階独立レビューで、それを **お願い (advisory) ではなく exit 2 (DENY) で止める**。
> Claude Code Plugin として配布。`/plugin install` で導入完了。

## 哲学

```
Quality by Structure, Not by Promise.

1. The Wall（壁）は説得されない
   プロンプトは提案。hooks は強制。品質を約束に委ねない。

2. architect が設計し、agent が実装する
   人間は何を作るかを決める。AIはどう作るかを実行する。
   曖昧さは architect に問い返す。推測で実装しない。

3. Proof or Block（証拠かブロックか）
   「できた」は証拠ではない。テストが通り、レビューが通過して初めて完了。
   証拠なき完了宣言は構造的にブロックされる。

4. fail-open — 品質にカルト的、自分自身に謙虚
   qult の障害で開発を止めない。壊れたら道を開ける。
   品質への狂信と、ツールへの謙虚さの共存。
```

> [!NOTE]
> セッション開始時に `SessionStart:startup hook error` や `Stop hook error` と表示されることがありますが、**これは qult のバグではありません**。
> Claude Code の UI が hook の成功/失敗を正しく判別できない既知のバグです ([#12671](https://github.com/anthropics/claude-code/issues/12671), [#21643](https://github.com/anthropics/claude-code/issues/21643), [#10463](https://github.com/anthropics/claude-code/issues/10463))。
> hook 自体は正常に動作しています。

> [!WARNING]
> **PreToolUse hook の DENY が無視される場合があります。** qult は正しく `exit 2` を返しますが、
> Claude Code がブロックせずにツールを実行してしまうケースが報告されています
> ([#21988](https://github.com/anthropics/claude-code/issues/21988), [#4669](https://github.com/anthropics/claude-code/issues/4669), [#24327](https://github.com/anthropics/claude-code/issues/24327))。
> Claude Code 側の修正待ちです。

[English README / README.md](README.md)

## How it works

```mermaid
flowchart LR
    Edit["Edit / Write"] --> Gate{"Gate\n(lint, type)"}
    Gate -- pass --> OK["Continue"]
    Gate -- fail --> PF["pending-fixes"]
    PF --> Next["別ファイルを\nEdit しようとする"]
    Next --> DENY["The Wall\n(DENY exit 2)"]
    DENY --> Fix["同じファイルを修正"]
    Fix --> Gate

    style DENY fill:#e67e80,color:#2d353b,stroke:#e67e80
    style OK fill:#a7c080,color:#2d353b,stroke:#a7c080
    style PF fill:#dbbc7f,color:#2d353b,stroke:#dbbc7f
```

Anthropic の [Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps) 記事が示した Generator-Evaluator パターンで動作:

```mermaid
flowchart TB
    subgraph Generator["Generator"]
        Claude["Claude 本体\n+ 7 hooks で品質ゲート"]
    end
    subgraph Evaluator["3段階 Evaluator"]
        Spec["Stage 1: Spec Reviewer\n(Completeness + Accuracy)"]
        Quality["Stage 2: Quality Reviewer\n(Design + Maintainability)"]
        Security["Stage 3: Security Reviewer\n(Vulnerability + Hardening)"]
    end

    Claude -- "タスク完了" --> TV["TaskCompleted\nVerify 即時実行"]
    TV -- "FAIL → 即修正" --> Claude
    TV -- "PASS" --> Claude
    Claude -- "全タスク完了" --> Spec
    Spec --> Quality
    Quality --> Security
    Security -- "FAIL / score < 24" --> Claude
    Security -- "PASS + score ≥ 24/30" --> Done["Commit"]

    style Generator fill:#7fbbb3,color:#2d353b,stroke:#7fbbb3
    style Evaluator fill:#e69875,color:#2d353b,stroke:#e69875
    style Done fill:#a7c080,color:#2d353b,stroke:#a7c080
    style TV fill:#dbbc7f,color:#2d353b,stroke:#dbbc7f
```

## 何を防ぐか

| 状況 | 行動 |
| --- | --- |
| lint/type エラーを放置して別ファイルへ | **The Wall** — 修正するまでブロック |
| テスト未実行で git commit | **The Wall** — テスト pass を要求 |
| レビュー未実行/FAIL で完了宣言 | **block** — /qult:review を要求 |
| レビュー PASS だがスコア低い | **block** — 傾向分析付きで再レビュー (最大3回) |
| Plan 確定時に漏れがある | **The Wall** — セッション全体の漏れチェックを強制 (1回) |
| Plan の途中で完了宣言 | **block** — 全タスク完了を要求 |
| Plan タスク完了時 | **verify** — Verify フィールドのテストを即時実行 |

## 完全なワークフロー

qult は 12 スキルと 6 エージェントで完全な開発ワークフローを提供:

```
/qult:explore    → architect にインタビュー、設計探索
/qult:plan-generator → 構造化実装計画の生成
    [Plan mode]  → architect がレビュー・承認
/qult:review     → 3段階独立レビュー (Spec → Quality → Security)
/qult:finish     → ブランチ完了 (merge/PR/hold/discard)
/qult:debug      → 構造化根本原因デバッグ
```

## 7 Hooks + MCP Server

| 分類 | Hook | 役割 |
| ------ | ------ | ------ |
| **初期化** (advisory) | SessionStart | state ディレクトリ初期化、stale ファイル掃除、startup 時に pending-fixes クリア |
| **The Wall** (enforcement) | PostToolUse | Edit/Write 後に lint/type gate 実行、state に書き込み |
| **The Wall** (enforcement) | PreToolUse | pending-fixes 未修正なら DENY、commit 前にテスト/レビュー要求、ExitPlanMode 時に漏れチェック強制 |
| **完了ゲート** (enforcement) | Stop | 未修正エラー・未完了タスク・レビュー未実施なら block |
| **サブエージェント** (enforcement) | SubagentStop | レビュー出力検証 + 傾向分析付きスコア閾値強制 (24/30) |
| **タスク検証** (advisory) | TaskCompleted | Plan タスク完了時に Verify テストを即時実行 |
| **コンテキスト** (advisory) | PostCompact | compaction 後に pending-fixes と session 状態を再注入 |

| MCP Tool | 役割 |
| ---------- | ------ |
| get_pending_fixes | lint/typecheck エラーの詳細を返す |
| get_session_status | テスト/レビュー状態を返す |
| get_gate_config | ゲート設定を返す |
| disable_gate | ゲートを一時的に無効化 |
| enable_gate | 無効化したゲートを再有効化 |
| set_config | .qult/config.json の設定値を変更 |
| clear_pending_fixes | pending-fixes を全クリア |

## インストール

### 1. プラグインの導入 (1回だけ)

```
/plugin marketplace add hir4ta/qult
/plugin install qult@hir4ta-qult
```

インストール後、Claude Code を再起動する（セッションを終了して新しいセッションを開始）。

### 2. プロジェクトのセットアップ (プロジェクトごとに1回)

```
/qult:init
```

init が行うこと:

- `.qult/` ディレクトリ作成
- `.qult/gates.json` 生成 — プロジェクトの lint/typecheck/test ツールを自動検出
- `.gitignore` に `.qult/` 追加
- レガシーファイルの削除 (古い rules, hooks)

品質ルールは MCP server instructions で配信される — `.qult/` 以外のファイルはプロジェクトに配置されない。

### 3. 動作確認

```
/qult:doctor
```

### init 後に使えるコマンド

| コマンド | 説明 |
| --------- | ------ |
| `/qult:explore` | 設計探索 — architect にインタビューしてからコーディング |
| `/qult:plan-generator` | 機能説明から構造化 Plan を生成 |
| `/qult:review` | 3段階独立コードレビュー (Spec + Quality + Security) |
| `/qult:finish` | ブランチ完了ワークフロー (merge/PR/hold/discard) |
| `/qult:debug` | 構造化根本原因デバッグ |
| `/qult:status` | 現在の品質ゲート状態を表示 |
| `/qult:skip` | ゲートの一時無効化/有効化、pending-fixes クリア |
| `/qult:config` | 設定値の確認・変更（閾値、イテレーション上限等） |
| `/qult:doctor` | セットアップの健全性チェック |
| `/qult:register-hooks` | hooks を settings.local.json に登録 (フォールバック) |
| `/qult:writing-skills` | スキル作成の TDD 手法 |

hooks (SessionStart, PostToolUse, PreToolUse, Stop, SubagentStop, TaskCompleted, PostCompact) と MCP server は自動で動作する。

### hooks が発火しない場合

plugin hooks は一部の環境で正常に発火しない既知の問題がある ([#18547](https://github.com/anthropics/claude-code/issues/18547), [#10225](https://github.com/anthropics/claude-code/issues/10225))。インストール後に hooks が動かない場合:

```
/qult:register-hooks
```

同じ hooks を `.claude/settings.local.json` にフォールバックとして登録する。plugin hooks と settings hooks の両方が存在する場合、Claude Code が重複排除する (同一コマンドは1回だけ実行)。`.claude/settings.local.json` は gitignore されるため、チームメンバーに影響しない。

## 3段階レビュー

qult のレビュー (`/qult:review`) は3つの専門 Opus レビュアーを順番にスポーンする:

| ステージ | エージェント | 評価次元 | 焦点 |
|-------|-------|-----------|-------|
| 1 | **Spec Reviewer** | Completeness + Accuracy | 実装が Plan に合致しているか？コンシューマは更新されているか？ |
| 2 | **Quality Reviewer** | Design + Maintainability | コード設計は適切か？エッジケースは処理されているか？ |
| 3 | **Security Reviewer** | Vulnerability + Hardening | インジェクションリスクは？多層防御は適用されているか？ |

各エージェントが2次元を採点 (各1-5)。合計: **6次元 / 30点満点**。
デフォルト閾値: **24/30** (設定変更可能)。最大3イテレーション。

全レビュアー完了後、Judge フィルタが各検出事項の簡潔性・正確性・実行可能性を検証する。

## 更新

`/plugin` > qult 詳細 > 更新。hooks, skills, agents, MCP server が全て自動更新される。追加のコマンドは不要 — 品質ルールは MCP instructions で配信されるため、プロジェクトファイルの更新は不要。

## アンインストール

`/plugin` > qult を削除。プロジェクトの `.qult/` は手動で削除。

## 設定

`.qult/config.json` で閾値をカスタマイズできる (全てオプション):

```json
{
  "review": {
    "score_threshold": 24,
    "max_iterations": 3,
    "required_changed_files": 5
  },
  "gates": {
    "output_max_chars": 2000,
    "default_timeout": 10000
  }
}
```

| キー | 型 | デフォルト | 説明 |
| ------ | ---- | ----------- | ------ |
| `review.score_threshold` | number | 24 | 3段階レビュー合格に必要な合計スコア (最大30) |
| `review.max_iterations` | number | 3 | レビュー再試行の最大回数 |
| `review.required_changed_files` | number | 5 | レビュー必須になる変更ファイル数 |
| `gates.output_max_chars` | number | 2000 | ゲート出力の最大文字数 (超過分は truncate) |
| `gates.default_timeout` | number | 10000 | ゲートコマンドのタイムアウト (ms) |

環境変数: `QULT_REVIEW_SCORE_THRESHOLD`, `QULT_REVIEW_MAX_ITERATIONS`, `QULT_REVIEW_REQUIRED_FILES`, `QULT_GATE_OUTPUT_MAX`, `QULT_GATE_DEFAULT_TIMEOUT`

<details>
<summary><strong>レビュースコア閾値の根拠</strong></summary>

3段階レビューは6つの観点 (Completeness, Accuracy, Design, Maintainability, Vulnerability, Hardening) を各1-5で採点する。デフォルト閾値 24/30 の意味:

- 4+4+4+4+4+4 = 24: 全観点で一貫した「良好」
- 5+5+5+5+2+2 = 24: コードは優秀だがセキュリティが弱い（ギリギリ通過）
- 3+3+3+3+3+3 = 18: 不合格。全体的な品質不足は検出される
- 5+5+4+4+4+4 = 26: 強いコードは余裕で通過

閾値はプロジェクトに合わせて変更可能。プロトタイプなら下げる (`"score_threshold": 18`)、本番APIなら上げる (`"score_threshold": 27`)。

スコアはLLM生成のため完全な再現性はない。トレンド検知付きイテレーション (`max_iterations` 回まで再試行) で補正: スコアが改善傾向ならフィードバックが機能している証拠。停滞なら別のアプローチを提案する。

</details>

<details>
<summary><strong>対応言語・ツール</strong></summary>

| 言語 | on_write (lint/type) | on_commit (test) | on_review (e2e) |
| --- | --- | --- | --- |
| **TypeScript/JS** | biome / eslint / tsc | vitest / jest / mocha | — |
| **Python** | ruff / pyright / mypy | pytest | — |
| **Go** | go vet | go test | — |
| **Rust** | cargo clippy / check | cargo test | — |
| **Ruby** | rubocop | rspec | — |
| **Java/Kotlin** | ktlint / detekt | gradle test / mvn test | — |
| **Elixir** | credo | mix test | — |
| **Deno** | deno lint | deno test | — |
| **Frontend** | stylelint | — | playwright / cypress / wdio |

</details>

### カスタムゲート

`.qult/gates.json` を直接編集してゲートの追加・変更・削除ができる:

```json
{
  "on_write": {
    "lint": { "command": "biome check {file}", "timeout": 3000 },
    "typecheck": { "command": "bun tsc --noEmit", "timeout": 10000, "run_once_per_batch": true },
    "custom-check": { "command": "my-tool check {file}", "timeout": 5000 }
  },
  "on_commit": {
    "test": { "command": "bun vitest run", "timeout": 30000 }
  },
  "on_review": {
    "e2e": { "command": "playwright test", "timeout": 120000 }
  }
}
```

**ゲートフィールド:**

| フィールド | 必須 | 説明 |
| ----------- | ------ | ------ |
| `command` | Yes | シェルコマンド。`{file}` は編集されたファイルパスに置換される |
| `timeout` | No | タイムアウト (ms)。省略時は `gates.default_timeout` |
| `run_once_per_batch` | No | true の場合、同一セッション内での再実行をスキップ (`tsc --noEmit` のようなプロジェクト全体チェック向け) |
| `extensions` | No | チェック対象の拡張子配列 (例: `[".ts", ".tsx"]`)。省略時はコマンドから推定 |

**ゲートカテゴリ:**

| カテゴリ | 実行タイミング | 典型的なゲート |
| --------- | --------------- | --------------- |
| `on_write` | Edit/Write の度に実行 | lint, typecheck |
| `on_commit` | `git commit` 検出時 | test |
| `on_review` | `/qult:review` 実行時 | e2e |

### ゲートの無効化

`.qult/gates.json` からゲートのエントリを削除するか、カテゴリごと削除する:

```json
{
  "on_write": {
    "lint": { "command": "biome check {file}", "timeout": 3000 }
  }
}
```

一時的に全ゲートを無効化するには `.qult/gates.json` をリネームまたは削除する。qult は fail-open 設計のため、ゲートなし = 制約なし。`/qult:init` で再生成可能。

### モノレポ・ワークスペース

qult はプロジェクトルートからゲートを検出する。ワークスペースごとに異なるツールを使う場合は `.qult/gates.json` を手動編集:

```json
{
  "on_write": {
    "lint-frontend": {
      "command": "cd packages/frontend && eslint {file}",
      "timeout": 5000,
      "extensions": [".tsx", ".jsx"]
    },
    "lint-backend": {
      "command": "cd packages/backend && biome check {file}",
      "timeout": 3000,
      "extensions": [".ts"]
    },
    "typecheck": {
      "command": "tsc --noEmit",
      "timeout": 15000,
      "run_once_per_batch": true
    }
  }
}
```

`extensions` でファイルを適切なリンターにルーティングする。`{file}` プレースホルダには編集されたファイルの絶対パスが入る。

## プラグインアーキテクチャ

qult は Claude Code Plugin が提供できる全コンポーネントを活用:

```
plugin/
├── .claude-plugin/plugin.json    マニフェスト
├── .mcp.json                     MCP server (状態管理 + ルール注入)
├── .lsp.json                     LSP server (TS/Python/Go/Rust)
├── settings.json                 デフォルトエージェント (quality-guardian)
├── hooks/hooks.json              7 enforcement hooks
├── agents/                       6 エージェント
├── skills/                       12 スキル
├── bin/qult-gate                 CLI ツール (status, run-lint, run-test)
├── output-styles/quality-first.md  出力スタイル
└── dist/                         バンドル (hook + MCP server)
```

| コンポーネント | 役割 |
|-------------|------|
| **hooks** | 強制 — 品質違反を DENY (exit 2) でブロック |
| **MCP server** | 状態管理 + instructions でルール注入 |
| **skills** | 対話ワークフロー (explore, review, debug, finish) |
| **agents** | 独立評価者 (plan, spec, quality, security) |
| **settings.json** | quality-guardian をデフォルトセッションエージェントに |
| **.lsp.json** | リアルタイム diagnostics (TypeScript, Python, Go, Rust) |
| **bin/** | `qult-gate` CLI で手動ゲート操作 |
| **output-styles/** | "Quality First" 出力スタイル — 簡潔、証拠ベース、ゲート対応 |

### 出力スタイル

`/config` > Output style で "Quality First" を選択可能。qult 用語を使い、レスポンスにゲートステータスを含める。

### CLI ツール

プラグイン有効時、`qult-gate` が PATH に追加される:

```bash
qult-gate status       # ゲート設定と保留中の修正を表示
qult-gate run-lint <f> # on_write ゲートをファイルに対して実行
qult-gate run-test     # on_commit ゲートを実行
qult-gate version      # qult バージョン表示
```

### LSP 連携

TypeScript, Python, Go, Rust の LSP サーバー設定を提供。LSP により Claude がリアルタイムで診断情報を取得 — ゲート実行前にエラーを検出。

> LSP サーバーは別途インストールが必要 (`npm i -g typescript-language-server`, `pip install pyright`, `gopls`, `rust-analyzer`)。

## 設計原則

| 原則 | 意味 |
| ------ | ------ |
| **The Wall > 情報提示** | DENY (exit 2) で止める。advisory は無視される前提 |
| **fail-open** | 全 hook は try-catch。qult の障害で Claude を止めない |
| **Proof or Block** | 証拠なき完了宣言は許さない |
| **structural guarantee** | 品質を構造で保証する。仮定を stress-test し、崩れたら削除 |
| **dependencies ゼロ** | 全て devDependencies + bun build バンドル |

## エージェント

| エージェント | モデル | 役割 |
|-------|-------|---------|
| **quality-guardian** | inherit | デフォルトセッションエージェント。qult 哲学を全対話に埋め込む |
| **plan-generator** | Opus | コードベース分析、構造化実装計画の生成 |
| **plan-evaluator** | Opus | 実装前の計画品質評価 (Feasibility, Completeness, Clarity) |
| **spec-reviewer** | Opus | 実装が計画に合致しているか検証 (Completeness, Accuracy) |
| **quality-reviewer** | Opus | コード品質とエッジケースの評価 (Design, Maintainability) |
| **security-reviewer** | Opus | OWASP Top 10 セキュリティレビュー (Vulnerability, Hardening) |

## データストレージ

```
.qult/
└── .state/
    ├── session-state-{id}.json
    └── pending-fixes-{id}.json
```

- セッション ID でスコープ (並行セッション安全)
- 24h 経過した古いファイルは自動クリーンアップ

## トラブルシューティング

<details>
<summary><strong>"Hook Error" がセッション開始時に表示される</strong></summary>

qult のバグではない。Claude Code の UI が hook の成功/失敗を正しく判別できない既知のバグ ([#12671](https://github.com/anthropics/claude-code/issues/12671), [#34713](https://github.com/anthropics/claude-code/issues/34713))。hook は正常に動作している。

</details>

<details>
<summary><strong>DENY したのにツールが実行される</strong></summary>

Claude Code 側の既知バグ ([#21988](https://github.com/anthropics/claude-code/issues/21988), [#24327](https://github.com/anthropics/claude-code/issues/24327))。qult は正しく exit 2 を返しているが、Claude Code がブロックしないケースがある。修正待ち。

</details>

<details>
<summary><strong>ゲートが検出されない</strong></summary>

`/qult:init` を実行。ツールのバイナリが PATH にあることを確認 (`which biome`, `which tsc` 等)。`node_modules/.bin` も自動的に検索される。

</details>

<details>
<summary><strong>state ファイルが壊れた</strong></summary>

`.qult/.state/` 内のファイルを削除して新しいセッションを開始する。qult は fail-open 設計のため、state ファイルが破損しても Claude は止まらない。

</details>

<details>
<summary><strong>特定のファイルでゲートをスキップしたい</strong></summary>

`.qult/gates.json` の各ゲートに `extensions` フィールドを追加して、対象拡張子を制限できる:

```json
{
  "on_write": {
    "lint": { "command": "biome check {file}", "extensions": [".ts", ".tsx"] }
  }
}
```

</details>

<details>
<summary><strong>ゲートが誤検出する (実際にはエラーでないのにブロックされる)</strong></summary>

1. ゲートコマンドをターミナルで手動実行して結果を確認
2. ツール設定の問題なら `.eslintrc.json` や `biome.json` 等を修正
3. qult が間違ったツールを実行しているなら `.qult/gates.json` のコマンドを修正
4. 最終手段として `.qult/gates.json` からゲートを削除

qult は `gates.json` のコマンドをそのまま実行する。誤検出はツール設定の問題であり、qult 側の修正は不要。

</details>

<details>
<summary><strong>レビューが低スコアで繰り返しブロックされる</strong></summary>

レビューイテレーション上限はデフォルト3回。3回目以降は通過する。スコアイテレーションをスキップしたい場合:

- `.qult/config.json` の `review.score_threshold` を下げる
- または環境変数 `QULT_REVIEW_SCORE_THRESHOLD=18` を設定

スコアが停滞する場合 (同じスコアが繰り返される)、SubagentStop hook が根本的に異なるアプローチを提案する。これは設計通り: 同じ修正戦略を繰り返してもスコアは改善しない。

</details>

<details>
<summary><strong>qult がコミットをブロックするが今すぐコミットしたい</strong></summary>

qult は PreToolUse hook でゲートを強制する。緊急時の回避方法:

1. ターミナルで直接コミット (Claude Code の外): `git commit -m "emergency fix"`
2. または一時的に qult を無効化: `/plugin` > qult を無効化 > コミット > 再有効化

`.qult/.state/` を削除してバイパスしないこと。セッション追跡がすべてクリアされ、予期しない動作の原因になる。

</details>

## スタック

TypeScript / MCP SDK / vitest (テスト) / Biome (lint)

Claude Code Plugin として配布。開発には Bun 1.3+ が必要。
