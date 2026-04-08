# qult

**Quality by Structure, Not by Promise.** Claude Code の品質を構造で守る evaluator harness。Claude Code Plugin として配布。

## 哲学

- **The Wall doesn't negotiate** — プロンプトは提案。hooks は強制。品質を約束に委ねない
- **architect が設計し、agent が実装する** — 人間は何を作るかを決める。AIはどう作るかを実行する
- **Proof or Block** — 証拠なき完了宣言は構造的にブロック
- **fail-open** — qult の障害で開発を止めない。壊れたら道を開ける

## スタック

TypeScript (Bun 1.3+, ESM) / vitest (テスト) / Biome (lint) / bun:sqlite (状態管理) / raw JSON-RPC MCP (状態公開)

**ランタイム要件**: Bun 必須（hooks, MCP server は `bun` で実行）、Semgrep 推奨（未インストール時は内蔵 security-check がフォールバック。`brew install semgrep` or `pip install semgrep`）

## コマンド

```bash
bun run build    # bun build (hook.mjs + mcp-server.mjs)
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
│   ├── hooks/hooks.json             # 7 hooks
│   ├── .mcp.json                    # MCP server
│   ├── skills/                      # 12 skills
│   ├── agents/                      # 6 agents
│   ├── bin/qult-gate                # CLI ツール
│   ├── output-styles/               # 出力スタイル
│   ├── .lsp.json                    # LSP server 設定
│   ├── settings.json                # デフォルトエージェント設定
│   └── dist/                        # バンドル (hook.mjs, mcp-server.mjs)
└── src/                             # ソースコード (開発用)
```

## 設計原則

1. **The Wall > 情報提示** — DENY (exit 2) が唯一の強制手段
2. **fail-open** — 全 hook は try-catch で握りつぶす。qult の障害で Claude を止めない
3. **Proof or Block** — 品質を構造で保証する。仮定を stress-test し、崩れたら削除
4. **hooks = 検出 + ブロック、MCP = 情報伝達** — stdout 不使用 (#16538 回避)

## ルール

### ビルド

- `bun build.ts` → `plugin/dist/hook.mjs` + `plugin/dist/mcp-server.mjs` (target: bun)
- **npm dependencies ゼロ** — 全て devDependencies + bun build バンドル。bun:sqlite はランタイム組み込み
- `better-sqlite3` は devDependency（vitest 用の bun:sqlite 互換 shim）

### Hook 設計 (7 hooks)

- 全 hook は fail-open (try-catch で握りつぶす)
- exit 2 = DENY/block (唯一の強制手段)。stderr に理由を出力
- **enforcement hooks は stdout 不使用** — plugin hook output bug (#16538) を回避
- SessionStart: DB セッション初期化、startup/clear 時のみ pending-fixes クリア
- PostToolUse: gate 並列実行 (Promise.allSettled) → state 書き込み (pending-fixes)
- PreToolUse: pending-fixes チェック → exit 2 (DENY)。Bash は `if: "Bash(git commit*)"` で絞り込み
- Stop/SubagentStop: 完了条件チェック → exit 2 (block)
- TaskCompleted: Verify テスト実行 → state 書き込み
- PostCompact: compaction 後に pending-fixes と session 状態を stdout で再注入
- PreToolUse (ExitPlanMode): 1回目を DENY してセッション全体の漏れチェックを強制
- 全 state は `~/.qult/qult.db` (SQLite WAL mode) に保存。プロジェクト内に `.qult/` は作らない
- lazyInit: SessionStart が発火しない環境向けの fallback

### MCP Server

- Claude が状態を取得・操作する経路
- raw stdio JSON-RPC 実装 (SDK 依存なし)
- 読み取り: get_pending_fixes, get_session_status, get_gate_config, get_detector_summary
- 分析: get_harness_report, get_handoff_document, get_metrics_dashboard, get_flywheel_recommendations
- 操作: disable_gate, enable_gate, clear_pending_fixes, set_config, save_gates
- 記録: record_review, record_test_pass, record_stage_scores, record_human_approval
- get_flywheel_recommendations: セッション横断パターン分析に基づく閾値調整推奨を返す
- disable_gate は gate 名をバリデーション（gate_configs テーブルのキー + "review", "security-check", "dead-import-check", "duplication-check"）
- MCP tool の呼び出しルールは MCP server instructions で注入（プロジェクトにファイル配置しない）

### Config 優先順位

- DEFAULTS < `global_configs` テーブル < `project_configs` テーブル < `QULT_*` env
- review.models.*: ステージ別レビュアーモデル (`QULT_REVIEW_MODEL_SPEC/QUALITY/SECURITY/ADVERSARIAL`)
- plan_eval.models.*: プランエージェントモデル (`QULT_PLAN_EVAL_MODEL_GENERATOR/EVALUATOR`)
- flywheel.*: セッション横断学習 (`QULT_FLYWHEEL_ENABLED`, `QULT_FLYWHEEL_MIN_SESSIONS`)

### Gates

- on_write: 編集時 (lint, typecheck) / on_commit: コミット時 (test) / on_review: レビュー時 (e2e)

### 消費者チェック

- 型変更 (types.ts, session-state.ts) は必ず消費者への波及を確認

### Phase Gate (各コミット前に必ず実行)

1. `bun vitest run` — 全テスト pass
2. `bun vitest run src/__tests__/simulation.test.ts` — シミュレーション pass
3. `bun tsc --noEmit && bun biome check src/` — 型 + lint clean
4. `/qult:review` — 独立レビュー (自己評価は機能しない。必ずサブエージェントで実行)
5. コミット — Phase Gate 通過後にのみコミット

### シミュレーション

- Hook や状態管理の変更後は simulation.test.ts にシナリオを追加する
- シミュレーションは本番フロー (Edit→gate→pending-fixes→DENY) を再現する統合テスト

### Claude Code 公式仕様の調査

- Claude Code の hooks、plugins、skills、agents、MCP 等の公式仕様を調べるときは `claude-code-guide` エージェントを必ず使う
- WebSearch や WebFetch で独自にリサーチしに行かないこと

### 設計の参考文献

qult の設計は以下の論文・記事に基づいている。機能追加や設計判断の際はこれらの原則に立ち返ること。

- [Anthropic: Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps) — Generator-Evaluator パターン、自己評価バイアス、コンテキスト一貫性の喪失。qult の hook（センサー）+ skill（ガイド）の二層構造の根拠
- [Anthropic: Effective Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — 長時間セッション設計、構造化ハンドオフ
- [Martin Fowler: Harness Engineering](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html) — ガイド（フィードフォワード）+ センサー（フィードバック）の分類体系。Agent = Model + Harness
- [Martin Fowler: Humans and Agents](https://martinfowler.com/articles/exploring-gen-ai/humans-and-agents.html) — "On the Loop" モデル、Agentic Flywheel
- [TDAD: Test-Driven Agentic Development](https://arxiv.org/abs/2603.17973) — プロンプトのみの TDD はリグレッションを悪化させる (6%→10%)。構造的強制で 1.8% に低減。TDD 強制の根拠
- [Specification as Quality Gate](https://arxiv.org/abs/2603.25773) — AI が AI をレビューすると相関エラーが増幅。決定論的ゲートを先に、AI レビューは残余のみ。4 段階レビューの前に lint/typecheck/test を実行する根拠
- [VibeGuard](https://arxiv.org/abs/2604.01052) — AI 生成コードのセキュリティゲートフレームワーク
- [PGS: Property-Generated Solver](https://ai-scholar.tech/en/articles/llm-paper/property-generated-solver) — プロパティベーステストで +37.3% の正確性向上
- [Google DeepMind: Scaling Agent Systems](https://arxiv.org/abs/2512.08296) — 独立エージェントはエラーを 17.2 倍に増幅。4 エージェント超で協調オーバーヘッドが利益を消費。マルチエージェント設計の上限根拠
- [Columbia DAPLab: 9 Critical Failure Patterns](https://daplab.cs.columbia.edu/general/2026/01/08/9-critical-failure-patterns-of-coding-agents.html) — サイレント障害・ビジネスロジック不一致・コードベース認識劣化。構造的ゲートで防げる失敗と防げない失敗の分類
- [Is Vibe Coding Safe? (CMU)](https://arxiv.org/abs/2512.03262) — 機能的に正しいコードの 61% がセキュアでない (10.5%)。プロンプトによるセキュリティ誘導は無効。構造的ゲート必須の根拠
- [FeatureBench (ICLR 2026)](https://arxiv.org/abs/2602.10975) — SWE-bench 74.4% → 複雑な機能開発で 11.0%。タスク分割の構造的支援が不可欠
- [Agent Drift](https://arxiv.org/abs/2601.04170) — semantic/coordination/behavioral drift の 3 分類。長時間セッションでの状態管理・アンカリングの根拠
- [Code Review Agents in PRs](https://arxiv.org/abs/2604.03196) — AI レビューコメントの採用率 0.9-19.2%。レビュー結果を exit 2 で強制する設計の根拠
- [METR: AI Developer Productivity](https://arxiv.org/abs/2507.09089) — 経験者 RCT で AI 使用時タスク完了が 19% 遅延。体感速度の錯覚を品質ゲートで補正する根拠
- [Anthropic: Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — コンテキストエンジニアリングの体系的アプローチ。PostCompact 状態再注入の理論的基盤
- [Anthropic: 2026 Agentic Coding Trends](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf) — 8つのトレンド: エンジニアリング役割の変化、マルチエージェント協調、ガードレールによるスケーラブルな品質保証
- [Columbia DAPLab: Policy Enforcement](https://daplab.cs.columbia.edu/general/2026/01/10/vibe-coding-needs-policy-enforcement.html) — エージェントは要件を「好み」として扱う。ポリシーの構造的強制が必要。The Wall の理論的裏付け
- [Columbia DAPLab: Agent README Problem](https://daplab.cs.columbia.edu/general/2026/03/31/your-ai-agent-doesnt-care-about-your-readme.html) — 人間向けドキュメントはエージェントに機能しない。AGENTS.md/llms.txt の必要性
- [Microsoft Research: Willful Disobedience (AgentPex)](https://arxiv.org/abs/2603.23806) — エージェントはプロンプトルールを選択的に無視する。outcome ベンチマークは手続き的失敗を見逃す。構造的強制の追加根拠
- [Detecting Silent Failures in Multi-Agent Systems](https://arxiv.org/abs/2511.04032) — マルチエージェントの異常検出。drift/cycle/missing-detail/tool-failure の分類。96-98% の検出精度
- [CodeRabbit: AI vs Human Code Report](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report) — AI コードは 1.7 倍の問題を生成。セキュリティバグ 1.5-2 倍、過剰 I/O 8 倍。品質ゲートの定量的根拠
- [Nonstandard Errors in AI Agents](https://arxiv.org/abs/2603.16744) — 150 エージェントの独立実験。異なるモデルファミリーは安定して異なる分析スタイル。レビュアーモデル多様性の根拠
- [Triple Debt Model: Technical + Cognitive + Intent](https://arxiv.org/abs/2603.22106) — AI はコードを理解より速く生成する。認知負債・意図負債の概念。品質ゲートだけでは防げない新たな課題
- [Debt Behind the AI Boom](https://arxiv.org/abs/2603.28592) — 304K AI コミットの実証分析。AI コードの品質問題が技術負債として蓄積するか検証
- [VibeContract](https://arxiv.org/abs/2603.15691) — 自然言語意図をタスクレベル契約に分解。入出力・制約・振る舞いプロパティを明示化。property-based testing 統合の方向性
- [AI Technical Debt and Maintenance](https://arxiv.org/abs/2510.10165) — AI コードはリワーク増加。コア開発者の生産性 19% 低下。短期的生産性 vs 長期持続性のトレードオフ
- [Addy Osmani: The 80% Problem](https://addyo.substack.com/p/the-80-problem-in-agentic-coding) — エージェントは 80% を高速生成するが残り 20% に深いコンテキスト知識が必要。「エージェントは知らないことを知らない」
- [TDFlow: Agentic Workflows for TDD](https://arxiv.org/abs/2510.23761) — リポジトリ規模のソフトウェアエンジニアリングをテスト解決タスクとしてフレーム化
- [AgentFixer](https://arxiv.org/abs/2603.29848) — LLM エージェントシステムの障害検出から修正推奨へ
- [Near-Miss: Latent Policy Failure Detection](https://arxiv.org/abs/2603.29665) — エージェントワークフローの潜在的ポリシー違反を検出
- [Agentic Evaluation Framework](https://arxiv.org/abs/2603.15976) — 3段階14評価器: バイナリゲート → 定量メトリクス → LLM品質評価。agents-evaluating-agents パラダイム
- [Stack Overflow: Are Bugs Inevitable with AI Agents?](https://stackoverflow.blog/2026/01/28/are-bugs-and-incidents-inevitable-with-ai-coding-agents/) — AI コードは 1.7 倍のバグ、ロジックエラー 75% 増、セキュリティバグ 1.5-2 倍。変更失敗率 30% 増、PR あたりインシデント 23.5% 増。品質ゲートの定量的必要性
- [MIT Tech Review: Rules Fail at the Prompt, Succeed at the Boundary](https://www.technologyreview.com/2026/01/28/1131003/rules-fail-at-the-prompt-succeed-at-the-boundary/) — プロンプトレベルのルールは構造的に失敗する。境界での強制のみが有効。The Wall 哲学の直接的な裏付け
- [Vibe Coding in Practice: Flow, Technical Debt, and Guidelines](https://arxiv.org/abs/2512.11922) — Vibe コーディングの実践分析。フロー・技術負債・持続可能な使用ガイドライン。認知負債と所有権の断片化
- [Agentic Property-Based Testing](https://arxiv.org/abs/2510.09907) — AI エージェントが自律的に PBT を生成。100 パッケージで 56% が有効なバグ、NumPy 等にパッチマージ。PBT 統合の将来方向
- [Anthropic: Property-Based Testing with Claude](https://red.anthropic.com/2026/property-based-testing/) — Anthropic 公式の PBT ガイド。AI 生成コードの検証にプロパティベーステストを適用する手法
- [HubSpot Sidekick: Multi-Model AI Code Review](https://www.infoq.com/news/2026/03/hubspot-ai-code-review-agent/) — マルチモデル AI レビューで 90% 高速化、80% エンジニア承認率。セカンダリ judge agent パターン
- [Faros AI: AI Productivity Paradox](https://www.faros.ai/blog/ai-software-engineering) — AI 導入はバグ/開発者 9% 増、PR サイズ 154% 増。チームレベルの改善が組織レベルにスケールしない。個別最適と全体最適の乖離
- [AI Code Security Crisis 2026](https://www.growexx.com/blog/ai-code-security-crisis-2026-cto-guide/) — AI 生成コードが 5 件に 1 件のセキュリティ侵害の原因。CVE 月次開示数が急増 (Jan:6→Mar:35)。構造的セキュリティゲートの緊急性
- [AI Code Vulnerabilities 2.74x](https://www.softwareseni.com/ai-generated-code-security-risks-why-vulnerabilities-increase-2-74x-and-how-to-prevent-them/) — AI 生成コードの脆弱性は人間の 2.74 倍。45% にセキュリティ欠陥。インジェクション 33.1%、XSS 86% 失敗率
- [GitGuardian: Shifting Security Left for AI Agents](https://blog.gitguardian.com/shifting-security-left-for-ai-agents-enforcing-ai-generated-code-security-with-gitguardian-mcp/) — MCP 経由で AI エージェントにシークレット検出を統合。セキュリティの左シフトをエージェント時代に適用
- [Context Drift Kills Agents](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies) — 企業 AI 障害の 65% がコンテキストドリフトまたはメモリ喪失。35 分超で成功率低下、タスク時間 2 倍で失敗率 4 倍。PostCompact 再注入の定量的根拠
- [Simon Willison: Red/Green TDD for Agents](https://simonwillison.net/guides/agentic-engineering-patterns/red-green-tdd/) — エージェントに RED→GREEN→REFACTOR を構造的に強制するパターン。qult の TDD enforcement の実務的裏付け
- [Martin Kleppmann: AI Will Make Formal Verification Mainstream](https://martin.kleppmann.com/2025/12/08/ai-formal-verification.html) — AI + 形式検証 (vericoding) の方向性。プロパティベーステストから形式証明への橋渡し
- [Investigating Autonomous Agent Contributions in the Wild](https://arxiv.org/html/2604.00917v1) — 実環境での自律エージェント活動パターン分析。コード変更の時間経過に伴う品質変動
- [OpenAI Codex: 1M Lines Zero Manual Code](https://www.nxcode.io/resources/news/harness-engineering-complete-guide-ai-agent-codex-2026) — OpenAI が 100 万行をエージェントのみで生成。厳格なハーネス設計が前提。「ハーネスなきエージェントは負債製造機」
- [AgentPex: 83% of "Perfect" Traces Have Violations](https://arxiv.org/abs/2603.23806) — outcome が完璧でも 83% の Claude トレースに手続き的違反。outcome ベンチマークの限界を定量化。構造的監査の追加根拠
