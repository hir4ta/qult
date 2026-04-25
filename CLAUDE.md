# qult

**Claude を補助する品質エイド.** Claude Code 単体より、漏れなく品質高い設計・実装を実現するための補助プラグイン。Claude Code Plugin として配布。

## ミッション (最重要)

**qult の目的は Claude Code を補助すること。完璧なハーネスエンジニアリング実装ではない。**

ハーネスエンジニアリング論文 (`docs/references.md`) は **設計の参考** であり、完全再現が目的ではない。理論的純度より、ユーザーが日常で使えて鬱陶しくない補助を優先する。

### qult が**やること**（Claude 単体では確実にできない事）
- **Spec-Driven Development** (`/qult:spec` → `/qult:clarify` → `/qult:wave-start` → `/qult:wave-complete`) — markdown を single source of truth にした構造化フロー
- **独立スペック評価** (`spec-evaluator` 4 次元 × 3 phase) — requirements / design / tasks の各段に独立 gate
- **独立レビュー** (`/qult:review` 4 段) — reviewer モデル多様性で自己評価バイアスを軽減
- **外部知識統合** — Semgrep (SAST), osv-scanner (CVE), npm registry (hallucinated package 確認)
- **一貫性保証の detector** — test-quality-check は毎回必ず flag する
- **永続 state** — `.qult/state/*.json` で test pass / review 完了 / spec 状態を記録

### qult が**やらないこと**
- 厳密な policy compiler / reference monitor の実装
- ハーネスエンジニアリング論文の完全再現
- ユーザーの作業を構造的に中断するシステム (hooks は使わない)
- Claude が自分でできる判断の機械的代替 (複雑度計算、convention 検出、toolchain 検出 等は reviewer や Claude 判断に任せる)
- マルチツール対応（Cursor / Gemini CLI / Copilot 等）— 現状 Claude Code 専用、将来検討

### 既知の限界（正直）
- **Rules は advisory**: workflow rules はプロンプトレベルの誘導。AgentPex 研究: トレースの 83% に少なくとも 1 件の手続き違反。ルールは大抵守られるが信頼できるほどではない
- **レビューのトークンコスト**: `/qult:review` は 4 subagent 分で 40-100k トークン追加。Wave 単位の自動 review は無し、spec 完了時にのみ走る
- **Detector の言語バイアス**: pattern/AST ベースで TypeScript 偏り
- **複数 worktree 並列の保証なし**: 同一 repo を複数 worktree から同時編集すると last-write-wins。clone 単位で分離推奨

### 設計判断のスタンス
**迷ったら軽い方を選ぶ。**

- 「研究的に完璧か」より「ユーザーが日常で使うか」
- 「全言語に独自 detector」より「Claude に判断させて簡素化」
- 「全自動」より「必要な時だけ skill で能動起動」
- 「あらゆる metric を計測」より「Claude が読めば分かる事は計測しない」

新機能を追加する前に問う: **これは Claude が自分でできない事か？** Yes なら追加。No なら不要。

## 哲学

- **architect が設計し、agent が実装する** — 人間は何を作るかを決める。AI はどう作るかを実行する
- **Markdown is the source of truth** — spec / state はファイル。SQLite なし、global config なし
- **Independent Review Required** — 大きな変更は必ず 4-stage 独立レビュー (Spec → Quality → Security → Adversarial)。AI の自己評価は機能しない (研究: self-review は自己バグの 64.5% を見逃す)
- **fail-open** — qult の障害で開発を止めない

## スタック

TypeScript (Bun 1.3+, ESM) / vitest (テスト) / Biome (lint) / 純粋ファイル I/O (`.qult/state/*.json` + atomic rename) / raw JSON-RPC MCP (状態公開)

**ランタイム要件**: Bun 必須（MCP server は `bun` で実行）、Semgrep 推奨（security-check で使用、`brew install semgrep`）

## コマンド

```bash
bun run build    # bun build (mcp-server.mjs のみ)
bun run typecheck && bun run lint  # tsc --noEmit + Biome lint
bun run lint:fix # Biome 自動修正
bun run test     # bunx --bun vitest run
```

## Plugin 構造

```
qult/
├── .claude-plugin/marketplace.json  # マーケットプレイス定義
├── plugin/                          # プラグイン本体（配布物）
│   ├── .claude-plugin/plugin.json
│   ├── rules/                       # ~/.claude/rules/ に配布される workflow rules (5 ファイル)
│   ├── .mcp.json                    # MCP server 定義
│   ├── skills/                      # user-invocable skills (15 個)
│   ├── agents/                      # spec / reviewer agents (8 個)
│   ├── output-styles/               # 出力スタイル
│   ├── settings.json                # デフォルトエージェント設定
│   └── dist/                        # バンドル (mcp-server.mjs)
├── src/                             # ソースコード
└── .qult/                           # 自プロジェクトの spec ドキュメント (committed)
```

## ルール

### ビルド

- `bun build.ts` → `plugin/dist/mcp-server.mjs` (target: bun)
- **npm dependencies ゼロ** — `package.json` の `dependencies` は空。bun build で transitive バンドル

### `.qult/` ディレクトリ規約

```
.qult/
├── config.json              # committed: project-local config overrides
├── specs/                   # committed: spec markdown
│   ├── <active-spec>/
│   │   ├── requirements.md  # EARS notation
│   │   ├── design.md
│   │   ├── tasks.md         # Wave / task ツリー
│   │   └── waves/wave-NN.md # 各 Wave のメタ + commit range
│   └── archive/             # /qult:finish が完了 spec をここに移動
└── state/                   # gitignored: ephemeral (current/pending-fixes/stage-scores/gates/audit-log)
```

`/qult:init` が `.gitignore` を整備（`.qult/state/` は ignore、`.qult/specs/` と `.qult/config.json` は track）。広い `.qult/` ルールが既存ならば negation を追加。

### Rules (5 ファイル)

`plugin/rules/` のテンプレートを `/qult:init` / `/qult:update` で `~/.claude/rules/` に配布（常に上書き）:

- `qult-workflow.md` — Spec → Wave → Review → Finish の流れ
- `qult-pre-commit.md` — コミット前のチェックリスト（test, `[wave-NN]` prefix, review at spec end, finish）
- `qult-spec-mode.md` — `/qult:spec` の利用、`EnterPlanMode` の制限、Wave invariants、branch decoupling
- `qult-review.md` — `/qult:review` 4-stage の必要条件、active spec context、修正専用 Wave 規約
- `qult-quality.md` — Tier 1 detector、severity ベース block、spec 評価 threshold

### MCP Server

- Claude が状態を取得・操作する経路
- raw stdio JSON-RPC 実装 (SDK 依存なし)
- **Spec**: get_active_spec, complete_wave, update_task_status, archive_spec, record_spec_evaluator_score
- **State**: get_project_status, record_test_pass, record_review, record_stage_scores, record_human_approval, record_finish_started
- **Detector**: get_pending_fixes, clear_pending_fixes, get_detector_summary, get_file_health_score, get_impact_analysis, get_call_coverage
- **Gate / config**: disable_gate, enable_gate, set_config
- 全ての副作用は `.qult/state/*.json` への atomic rename ベースの書き込み

### Agent / Reviewer モデル

| Agent | Model | 役割 |
|-------|-------|------|
| spec-generator | sonnet | requirements / design / tasks の生成（phase 引数で切替） |
| spec-clarifier | **opus** | 5-10 問のクラリファイ生成 + 回答反映 |
| spec-evaluator | **opus** | 3 phase それぞれの 4 次元評価、threshold 18/17/16 |
| spec-reviewer | sonnet | spec ↔ implementation の整合性 |
| quality-reviewer | sonnet | design smell, maintainability |
| security-reviewer | **opus** | OWASP Top 10、Veracode 45% / CSA AI-CVE 6 倍を踏まえ最強モデル |
| adversarial-reviewer | **opus** | edge case の最終番人 |
| quality-guardian | sonnet | デフォルト session agent |

### Detector

**Tier 1 のみ**（reviewer が単独で判断できない / 自動化が必要なもの）:

- **security-check** — OWASP Top 10 パターン、ハードコードシークレット
- **dep-vuln-check** — osv-scanner 統合
- **hallucinated-package-check** — npm registry 存在確認
- **test-quality-check** — empty test, always-true, trivial assertion
- **export-check** — 破壊的 export 変更

**方針**: Claude がコードを読んで判断できる領域は detector 化しない。reviewer 判断に委ねる。

### Config 優先順位

- DEFAULTS < `.qult/config.json` < `QULT_*` env
- `review.*`: スコア閾値、iteration、次元フロア、モデル選択
- `spec_eval.thresholds.{requirements,design,tasks}`: phase 別 threshold
- `gates.import_graph_depth`: impact analysis 用 (1-3)
- `security.require_semgrep`: Semgrep 必須化

### TDD

- プロンプトレベル TDD は品質悪化リスクがあるため強制しない (TDAD 論文)
- 各 Wave の `Verify:` フィールドに検証コマンド / 観点を記述、`/qult:wave-complete` で実行

### 消費者チェック

- 型変更（`src/state/json-state.ts`、MCP tool schema 等）は必ず消費者への波及を確認

### Phase Gate (各コミット前に必ず実行)

1. `bun vitest run` — 全テスト pass
2. `bun tsc --noEmit && bun biome check src/` — 型 + lint clean
3. `bun run build` — ビルド成功
4. `/qult:review` — spec 完了時の独立レビュー（自己評価は機能しない。必ずサブエージェントで実行）
5. `[wave-NN]` prefix の commit — Phase Gate 通過後にのみコミット

### Claude Code 公式仕様の調査

- Claude Code の rules、plugins、skills、agents、MCP 等の公式仕様を調べるときは `claude-code-guide` エージェントを必ず使う
- WebSearch や WebFetch で独自にリサーチしに行かないこと

### 設計の参考文献

@docs/references.md
