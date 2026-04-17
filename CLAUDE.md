# qult

**Claude を補助する品質エイド.** Claude Code 単体より、漏れなく品質高い設計・実装を実現するための補助プラグイン。Claude Code Plugin として配布。v0.29 で hooks 全廃止、v0.30 で過剰機能を大量削除（flywheel/dataflow/complexity/mutation/SBOM/LSP 等）。

## ミッション (最重要)

**qult の目的は Claude Code を補助すること。完璧なハーネスエンジニアリング実装ではない。**

ハーネスエンジニアリング論文 (`docs/references.md`) は **設計の参考** であり、完全再現が目的ではない。理論的純度より、ユーザーが日常で使えて鬱陶しくない補助を優先する。

### qult が**やること**
- Claude が判断・推論で見落としやすい点を rules + agents + MCP で補強
- 独立レビュー (reviewer モデル多様性) で AI の自己評価バイアスを軽減
- 品質判断に必要なコンテキスト (state, gate config, detector findings) を MCP 経由で提供
- セキュリティ・依存関係など Claude が知らない情報源 (Semgrep, osv-scanner, npm registry) を統合

### qult が**やらないこと**
- 厳密な policy compiler / reference monitor の実装 (v0.28 までの hooks 思想は撤回)
- ハーネスエンジニアリング論文の完全再現 (理論的純度の追求はしない)
- ユーザーの作業を構造的に中断するシステム (Edit/Write 中の DENY、Stop hook ブロック等は v0.29 で撤廃)
- Claude が自分でできる判断の機械的代替 (複雑度計算、convention 検出 等は reviewer に任せる)

### 設計判断のスタンス
**迷ったら軽い方を選ぶ。**

- 「研究的に完璧か」より「ユーザーが日常で使うか」
- 「全言語に独自 detector」より「Claude に判断させて簡素化」
- 「全自動」より「必要な時だけ skill で能動起動」
- 「あらゆる metric を計測」より「Claude が読めば分かる事は計測しない」

新機能を追加する前に問う: **これは Claude が自分でできない事か？** Yes なら追加。No なら不要。

## 哲学

- **architect が設計し、agent が実装する** — 人間は何を作るかを決める。AI はどう作るかを実行する
- **Independent Review Required** — 大きな変更は必ず 4-stage 独立レビュー (Spec → Quality → Security → Adversarial)。AI の自己評価は機能しない (研究: self-review は自己バグの 64.5% を見逃す)
- **fail-open** — qult の障害で開発を止めない

## スタック

TypeScript (Bun 1.3+, ESM) / vitest (テスト) / Biome (lint) / bun:sqlite (状態管理) / raw JSON-RPC MCP (状態公開)

**ランタイム要件**: Bun 必須（MCP server は `bun` で実行）、Semgrep 推奨（security-check で使用、`brew install semgrep` or `pip install semgrep`）

## コマンド

```bash
bun run build    # bun build (mcp-server.mjs のみ)
bun run typecheck && bun run lint  # tsc --noEmit + Biome lint
bun run lint:fix # Biome 自動修正
bun run test     # vitest run
```

`bun tsc` / `bun vitest` を使う（`npx` 不要）

## Plugin 構造

```
qult/
├── .claude-plugin/marketplace.json  # マーケットプレイス定義
├── plugin/                          # プラグイン本体
│   ├── .claude-plugin/plugin.json
│   ├── rules/                       # ~/.claude/rules/ に配布される workflow rules (5 ファイル)
│   ├── .mcp.json                    # MCP server
│   ├── skills/                      # 12 skills
│   ├── agents/                      # 7 agents (4 reviewer + plan-generator/evaluator + quality-guardian)
│   ├── output-styles/               # 出力スタイル
│   ├── .lsp.json                    # LSP server 設定
│   ├── settings.json                # デフォルトエージェント設定
│   └── dist/                        # バンドル (mcp-server.mjs)
└── src/                             # ソースコード (開発用)
```

## 設計原則

1. **Rules > Hooks** — `~/.claude/rules/qult-*.md` で workflow を Claude に教える。hooks は使わない
2. **fail-open** — qult の障害で Claude を止めない
3. **Independent Review** — `/qult:review` (4 stage) でレビュー多様性を保証 (sonnet × 3 + opus × 1)
4. **MCP = 情報伝達 + 状態記録** — DB と Claude をつなぐ唯一の経路

## ルール

### ビルド

- `bun build.ts` → `plugin/dist/mcp-server.mjs` (target: bun)
- **npm dependencies ゼロ** — 全て devDependencies + bun build バンドル。bun:sqlite はランタイム組み込み
- `better-sqlite3` は devDependency（vitest 用の bun:sqlite 互換 shim）

### Rules (5 ファイル)

`plugin/rules/` のテンプレートを `/qult:init` で `~/.claude/rules/` に配布（常に上書き）:

- `qult-workflow.md` — Plan → Implement → Review → Finish の流れ
- `qult-pre-commit.md` — コミット前のチェックリスト（test, review, finish）
- `qult-plan-mode.md` — `/qult:plan-generator` の利用、`EnterPlanMode` 禁止
- `qult-review.md` — `/qult:review` 4-stage の必要条件と detector context
- `qult-quality.md` — Tier 1 (常時) / Opt-in detectors の整理、TDD 強制なし

### MCP Server

- Claude が状態を取得・操作する経路
- raw stdio JSON-RPC 実装 (SDK 依存なし)
- 読み取り: get_pending_fixes, get_session_status, get_gate_config, get_detector_summary, get_file_health_score, get_impact_analysis, get_call_coverage
- 操作: disable_gate, enable_gate, clear_pending_fixes, set_config, save_gates, archive_plan
- 記録: record_review, record_test_pass, record_stage_scores, record_human_approval, record_finish_started
- MCP tool の呼び出しルールは MCP server instructions で注入（プロジェクトにファイル配置しない）

### Reviewer モデル

| Stage | Model | 理由 |
|-------|-------|------|
| spec-reviewer | sonnet | プランとの機械的照合、sonnet で十分 |
| quality-reviewer | sonnet | 高速、design smell の主要パターンは捕捉可能 |
| **security-reviewer** | **opus** | 高リスク。Veracode 45% / CSA AI-CVE 6 倍を踏まえ最強モデル |
| **adversarial-reviewer** | **opus** | 最終番人。edge case を捕捉 |
| plan-generator | sonnet | 生成タスク、sonnet で十分 |
| **plan-evaluator** | **opus** | 仕様品質ゲート。プランの腐敗が下流全体に波及するため |

### Detector triage (v0.30)

**Tier 1 のみ維持** — reviewer が読んで判断できない / 自動化が必要なもの:

- **security-check** — OWASP Top 10 パターン、ハードコードシークレット
- **dep-vuln-check** — osv-scanner 統合
- **hallucinated-package-check** — npm registry 存在確認
- **test-quality-check** — empty test, always-true, trivial assertion
- **export-check** — 破壊的 export 変更

**削除済み** (v0.30):
- dataflow-check, complexity-check, duplication-check, semantic-check, mutation-check (opt-in 全廃)
- convention-check, import-check (v0.29 削除済み)
- dead-import-check, spec-trace-check (v0.30 削除 — reviewer で十分)

**方針**: Claude がコードを読んで判断できる領域は detector 化しない。reviewer 判断に委ねる。

### Config 優先順位

- DEFAULTS < `global_configs` テーブル < `project_configs` テーブル < `QULT_*` env
- review.*: スコア閾値、iteration、次元フロア、モデル選択
- plan_eval.*: プラン評価スコア閾値、モデル
- gates.*: coverage_threshold (opt-in), import_graph_depth (impact analysis 用), output_max_chars, default_timeout
- security.require_semgrep: Semgrep 必須化

### State

- 全 state は `~/.qult/qult.db` (SQLite WAL mode) に保存。プロジェクト内に `.qult/` は作らない

### Gates

- on_write: 編集時 (lint, typecheck) / on_commit: コミット時 (test) / on_review: レビュー時 (e2e)
- 自動 fire はしない。`/qult:review` skill が gate コマンドを参照して reviewer に渡す

### TDD

- v0.29 で構造的強制を撤廃 (TDAD 論文: プロンプトのみ TDD は品質悪化リスク)
- TDD したい場合は plan の `Verify:` フィールドに記述、spec-reviewer が事後検証

### 消費者チェック

- 型変更 (types.ts, session-state.ts) は必ず消費者への波及を確認

### Phase Gate (各コミット前に必ず実行)

1. `bun vitest run` — 全テスト pass
2. `bun tsc --noEmit && bun biome check src/` — 型 + lint clean
3. `bun run build` — ビルド成功
4. `/qult:review` — 独立レビュー (自己評価は機能しない。必ずサブエージェントで実行)
5. コミット — Phase Gate 通過後にのみコミット

### Claude Code 公式仕様の調査

- Claude Code の rules、plugins、skills、agents、MCP 等の公式仕様を調べるときは `claude-code-guide` エージェントを必ず使う
- WebSearch や WebFetch で独自にリサーチしに行かないこと

### 設計の参考文献

@docs/references.md
