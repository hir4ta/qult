# qult

**Quality by Convention, Not by Coercion.** Claude Code の品質を rules + agents + MCP で支える evaluator harness。Claude Code Plugin として配布。v0.29 で hooks 全廃止。

## 哲学

- **架構より教化** — Claude Code 公式 hooks の不安定性 (#16538 等) と中断による生産性低下を踏まえ、強制ではなく合意による品質維持にシフト
- **architect が設計し、agent が実装する** — 人間は何を作るかを決める。AI はどう作るかを実行する
- **Independent Review Required** — 大きな変更は必ず 4-stage 独立レビュー (Spec → Quality → Security → Adversarial)
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
- 読み取り: get_pending_fixes, get_session_status, get_gate_config, get_detector_summary, get_file_health_score
- 分析: get_harness_report, get_handoff_document, get_metrics_dashboard, get_flywheel_recommendations
- 操作: disable_gate, enable_gate, clear_pending_fixes, set_config, save_gates
- 依存: generate_sbom (CycloneDX SBOM 生成, osv-scanner/syft), get_dependency_summary
- 記録: record_review, record_test_pass, record_stage_scores, record_human_approval
- get_flywheel_recommendations: セッション横断パターン分析に基づく閾値調整推奨を返す
- 操作（追加）: apply_flywheel_recommendations (raise 方向自動適用), transfer_knowledge (プロジェクト間知識転移 + rules テンプレート生成)
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

### Detector triage (v0.29)

- **Tier 1 (常時、`/qult:review` 推奨)**: security-check, dep-vuln-check, hallucinated-package-check, test-quality-check, export-check
- **Opt-in (`enable_gate` で起動)**: dataflow-check, complexity-check, duplication-check, semantic-check, mutation-test
- **削除済み**: convention-check, import-check (v0.29)
- **ユーティリティ維持** (auto-fire しない、MCP/LSP からのみ参照): dead-import-check (LSP fallback), spec-trace-check (`get_call_coverage` MCP tool)

### Config 優先順位

- DEFAULTS < `global_configs` テーブル < `project_configs` テーブル < `QULT_*` env
- review.models.*: ステージ別レビュアーモデル (`QULT_REVIEW_MODEL_SPEC/QUALITY/SECURITY/ADVERSARIAL`)
- plan_eval.models.*: プランエージェントモデル (`QULT_PLAN_EVAL_MODEL_GENERATOR/EVALUATOR`)
- flywheel.*: セッション横断学習 (`QULT_FLYWHEEL_ENABLED`, `QULT_FLYWHEEL_MIN_SESSIONS`, `QULT_FLYWHEEL_AUTO_APPLY`)
- gates.complexity_threshold: 循環的複雑度閾値（デフォルト 15、`QULT_COMPLEXITY_THRESHOLD`）
- gates.function_size_limit: 関数サイズ制限（デフォルト 50行、`QULT_FUNCTION_SIZE_LIMIT`）
- gates.mutation_score_threshold: ミューテーションスコア閾値（デフォルト 0 = 無効、`QULT_MUTATION_SCORE_THRESHOLD`）

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
