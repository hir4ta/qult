# 設計の参考文献

qult の設計は以下の論文・記事に基づいている。機能追加や設計判断の際はこれらの原則に立ち返ること。

## ハーネスエンジニアリング・評価フレームワーク

- [Anthropic: Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps) — Generator-Evaluator パターン、自己評価バイアス、コンテキスト一貫性の喪失。qult の hook（センサー）+ skill（ガイド）の二層構造の根拠
- [Anthropic: Effective Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — 長時間セッション設計、構造化ハンドオフ
- [Martin Fowler: Harness Engineering](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html) — ガイド（フィードフォワード）+ センサー（フィードバック）の分類体系。Agent = Model + Harness
- [Martin Fowler: Humans and Agents](https://martinfowler.com/articles/exploring-gen-ai/humans-and-agents.html) — "On the Loop" モデル、Agentic Flywheel
- [Anthropic: Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — コンテキストエンジニアリングの体系的アプローチ。PostCompact 状態再注入の理論的基盤
- [Anthropic: 2026 Agentic Coding Trends](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf) — 8つのトレンド: エンジニアリング役割の変化、マルチエージェント協調、ガードレールによるスケーラブルな品質保証
- [Anthropic: Managed Agents (Brain-Hands Separation)](https://www.anthropic.com/engineering/managed-agents) — ステートレスな実行コンテナと頭脳の分離。qult の hooks（センサー）と skills（ガイド）の分離パターンと一致
- [Agentic Evaluation Framework](https://arxiv.org/abs/2603.15976) — 3段階14評価器: バイナリゲート → 定量メトリクス → LLM品質評価。agents-evaluating-agents パラダイム
- [AEMA: Verifiable Evaluation Framework](https://arxiv.org/abs/2601.11903) — プロセス対応・監査可能なマルチエージェント評価ループ。4 役割: Planning/Prompt-Refinement/Evaluation/Final Report
- [Beyond Task Completion: Assessment Framework](https://arxiv.org/abs/2512.12791) — LLM/Memory/Tools/Environment の 4 柱評価。ツール記述の曖昧さやパラメータマッピング誤りが失敗の主因
- [CLEAR Framework: Beyond Accuracy](https://arxiv.org/abs/2511.14136) — Cost/Latency/Efficacy/Assurance/Reliability 評価。エージェント精度は単一実行 60% → 8 回一貫性 25%
- [OpenAI Codex: 1M Lines Zero Manual Code](https://www.nxcode.io/resources/news/harness-engineering-complete-guide-ai-agent-codex-2026) — 厳格なハーネス設計が前提。「ハーネスなきエージェントは負債製造機」

## TDD・仕様駆動開発

- [TDAD: Test-Driven Agentic Development](https://arxiv.org/abs/2603.17973) — プロンプトのみの TDD はリグレッションを悪化させる (6%→10%)。構造的強制で 1.8% に低減
- [Specification as Quality Gate](https://arxiv.org/abs/2603.25773) — AI が AI をレビューすると相関エラーが増幅。決定論的ゲートを先に、AI レビューは残余のみ
- [TDFlow: Agentic Workflows for TDD](https://arxiv.org/abs/2510.23761) — リポジトリ規模のソフトウェアエンジニアリングをテスト解決タスクとしてフレーム化
- [Simon Willison: Red/Green TDD for Agents](https://simonwillison.net/guides/agentic-engineering-patterns/red-green-tdd/) — エージェントに RED→GREEN→REFACTOR を構造的に強制するパターン
- [Spec-Driven Development](https://arxiv.org/abs/2602.00180) — spec-first/spec-anchored/spec-as-source の 3 段階。テスト = マイクロ仕様
- [Constitutional Spec-Driven Development](https://arxiv.org/abs/2602.02584) — CWE/MITRE Top 25 を「憲法」として機械可読化。構築時セキュリティ

## セキュリティ・脆弱性

- [VibeGuard](https://arxiv.org/abs/2604.01052) — AI 生成コードのセキュリティゲートフレームワーク
- [Is Vibe Coding Safe? (CMU)](https://arxiv.org/abs/2512.03262) — 機能的に正しいコードの 61% がセキュアでない (10.5%)。プロンプトによるセキュリティ誘導は無効
- [Security Degradation in Iterative AI Code](https://arxiv.org/abs/2506.11022) — 反復改善で重大脆弱性 37.6% 増加。セキュリティプロンプトは初期 1-3 回のみ有効
- [AI Code Vulnerabilities at Scale (GitHub)](https://arxiv.org/abs/2510.26103) — 7,703 ファイル、4,241 CWE。Python 脆弱性率 16-18.5%
- [Veracode 2025: GenAI Code Security](https://www.veracode.com/blog/genai-code-security-report/) — 45% のタスクでセキュリティ脆弱性。Java 72% 失敗。XSS 86% 失敗
- [AI Code Security Crisis 2026](https://www.growexx.com/blog/ai-code-security-crisis-2026-cto-guide/) — AI 生成コードが 5 件に 1 件のセキュリティ侵害の原因
- [AI Code Vulnerabilities 2.74x](https://www.softwareseni.com/ai-generated-code-security-risks-why-vulnerabilities-increase-2-74x-and-how-to-prevent-them/) — AI 生成コードの脆弱性は人間の 2.74 倍
- [GitGuardian: Shifting Security Left for AI Agents](https://blog.gitguardian.com/shifting-security-left-for-ai-agents-enforcing-ai-generated-code-security-with-gitguardian-mcp/) — MCP 経由で AI エージェントにシークレット検出を統合
- [Agent Skills Vulnerabilities at Scale](https://arxiv.org/abs/2601.10338) — 42,447 スキル分析。26.1% に脆弱性。データ漏洩 13.3%、権限昇格 11.8%

## コード品質・技術負債

- [CodeRabbit: AI vs Human Code Report](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report) — AI コードは 1.7 倍の問題を生成。セキュリティバグ 1.5-2 倍、過剰 I/O 8 倍
- [Triple Debt Model: Technical + Cognitive + Intent](https://arxiv.org/abs/2603.22106) — AI はコードを理解より速く生成する。認知負債・意図負債の概念
- [Debt Behind the AI Boom](https://arxiv.org/abs/2603.28592) — 304K AI コミットの実証分析。AI コードの品質問題が技術負債として蓄積するか検証
- [AI Technical Debt and Maintenance](https://arxiv.org/abs/2510.10165) — AI コードはリワーク増加。コア開発者の生産性 19% 低下
- [Human vs AI Code: Defects, Vulnerabilities, Complexity](https://arxiv.org/abs/2508.21634) — AI コードは単純・反復的だが未使用構造やハードコードデバッグが多い
- [AI Code Quality: SonarQube Study](https://arxiv.org/abs/2508.14727) — 5 LLM × 4,442 Java 課題。欠陥はモデル横断的な系統的弱点
- [AI Code in the Wild: Security & Ecosystem](https://arxiv.org/abs/2512.18567) — AI はグルーコード・テスト・リファクタリングに集中。コアロジックは人間
- [Vibe Coding in Practice](https://arxiv.org/abs/2512.11922) — Vibe コーディングの実践分析。フロー・技術負債・持続可能な使用ガイドライン
- [AI-Generated Build Code Quality](https://arxiv.org/abs/2601.16839) — 364 のビルドスメル。AI はビルド設定でも品質問題を導入
- [Stack Overflow: Are Bugs Inevitable with AI Agents?](https://stackoverflow.blog/2026/01/28/are-bugs-and-incidents-inevitable-with-ai-coding-agents/) — AI コードは 1.7 倍のバグ、ロジックエラー 75% 増
- [Faros AI: AI Productivity Paradox](https://www.faros.ai/blog/ai-software-engineering) — AI 導入はバグ/開発者 9% 増、PR サイズ 154% 増
- [Addy Osmani: The 80% Problem](https://addyo.substack.com/p/the-80-problem-in-agentic-coding) — エージェントは 80% を高速生成するが残り 20% に深いコンテキスト知識が必要

## AI コードレビュー

- [Code Review Agents in PRs](https://arxiv.org/abs/2604.03196) — AI レビューコメントの採用率 0.9-19.2%。レビュー結果を exit 2 で強制する設計の根拠
- [Human-AI Synergy in Code Review](https://arxiv.org/abs/2603.15911) — AI レビュー採用率 16.6% vs 人間 56.5%。半数以上の AI 提案が不正確
- [SWE-PRBench: AI Review vs Human Feedback](https://arxiv.org/abs/2603.26130) — 8 フロンティアモデルで人間指摘の 15-31% のみ検出。コンテキスト増加で性能低下
- [CR-Bench: AI Code Review Utility](https://arxiv.org/abs/2603.11078) — precision-recall トレードオフ。低 S/N 比が真の進歩を隠蔽
- [AI Code Review → Code Changes? (GitHub Actions)](https://arxiv.org/abs/2508.18771) — 22,000+ コメント分析。簡潔でコード片を含むコメントが最も効果的
- [HubSpot Sidekick: Multi-Model AI Code Review](https://www.infoq.com/news/2026/03/hubspot-ai-code-review-agent/) — マルチモデル AI レビューで 90% 高速化
- [Nonstandard Errors in AI Agents](https://arxiv.org/abs/2603.16744) — 異なるモデルファミリーは安定して異なる分析スタイル。レビュアーモデル多様性の根拠

## エージェント障害パターン・ポリシー強制

- [Columbia DAPLab: 9 Critical Failure Patterns](https://daplab.cs.columbia.edu/general/2026/01/08/9-critical-failure-patterns-of-coding-agents.html) — サイレント障害・ビジネスロジック不一致・コードベース認識劣化
- [Columbia DAPLab: Policy Enforcement](https://daplab.cs.columbia.edu/general/2026/01/10/vibe-coding-needs-policy-enforcement.html) — エージェントは要件を「好み」として扱う。ポリシーの構造的強制が必要
- [Columbia DAPLab: Agent README Problem](https://daplab.cs.columbia.edu/general/2026/03/31/your-ai-agent-doesnt-care-about-your-readme.html) — 人間向けドキュメントはエージェントに機能しない
- [Microsoft Research: Willful Disobedience (AgentPex)](https://arxiv.org/abs/2603.23806) — エージェントはプロンプトルールを選択的に無視する。83% のトレースに手続き的違反
- [MIT Tech Review: Rules Fail at the Prompt, Succeed at the Boundary](https://www.technologyreview.com/2026/01/28/1131003/rules-fail-at-the-prompt-succeed-at-the-boundary/) — プロンプトレベルのルールは構造的に失敗する
- [ODCV-Bench: Outcome-Driven Constraint Violations](https://arxiv.org/abs/2512.20798) — エージェントの制約違反率 30-50%
- [Near-Miss: Latent Policy Failure Detection](https://arxiv.org/abs/2603.29665) — エージェントワークフローの潜在的ポリシー違反を検出
- [AgentFixer](https://arxiv.org/abs/2603.29848) — LLM エージェントシステムの障害検出から修正推奨へ
- [Policy-as-Prompt: Governance → Guardrails](https://arxiv.org/abs/2509.23994) — ポリシーツリー → ランタイム分類器
- [Failed Agentic PRs in GitHub](https://arxiv.org/abs/2601.15195) — 33K エージェント PR 分析。バグ修正・パフォーマンスタスクが最低成績

## コンテキストドリフト・マルチエージェント

- [Agent Drift](https://arxiv.org/abs/2601.04170) — semantic/coordination/behavioral drift の 3 分類
- [Google DeepMind: Scaling Agent Systems](https://arxiv.org/abs/2512.08296) — 独立エージェントはエラーを 17.2 倍に増幅。4 エージェント超で協調オーバーヘッドが利益を消費
- [Detecting Silent Failures in Multi-Agent Systems](https://arxiv.org/abs/2511.04032) — drift/cycle/missing-detail/tool-failure の分類。96-98% の検出精度
- [Context Drift Kills Agents](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies) — 企業 AI 障害の 65% がコンテキストドリフトまたはメモリ喪失
- [AGENTS.md Impact on Agent Efficiency](https://arxiv.org/abs/2601.20404) — AGENTS.md でランタイム 28.64% 短縮、トークン消費 16.58% 減
- [AI Agents Need Memory Control](https://arxiv.org/abs/2601.11653) — メモリをインフラとして形式化。10 ターン超で永続メモリ必須
- [Code Agent Success/Failure Trajectories](https://arxiv.org/abs/2511.00197) — 失敗トラジェクトリは一貫して長く高分散

## テスト・PBT

- [PGS: Property-Generated Solver](https://ai-scholar.tech/en/articles/llm-paper/property-generated-solver) — プロパティベーステストで +37.3% の正確性向上
- [Agentic Property-Based Testing](https://arxiv.org/abs/2510.09907) — AI エージェントが自律的に PBT を生成。100 パッケージで 56% が有効なバグ
- [Anthropic: Property-Based Testing with Claude](https://red.anthropic.com/2026/property-based-testing/) — Anthropic 公式の PBT ガイド
- [VibeContract](https://arxiv.org/abs/2603.15691) — 自然言語意図をタスクレベル契約に分解。property-based testing 統合の方向性
- [Martin Kleppmann: AI Will Make Formal Verification Mainstream](https://martin.kleppmann.com/2025/12/08/ai-formal-verification.html) — AI + 形式検証の方向性
- [Testing AI Agents: Generation Quality & Coverage](https://arxiv.org/abs/2603.13724) — AI テスト作成コミット 16.4%
- [Testing Practices in AI Agent Frameworks](https://arxiv.org/abs/2509.19185) — テスト労力の 70%+ が決定論的コンポーネントに集中

## 生産性・ベンチマーク

- [METR: AI Developer Productivity](https://arxiv.org/abs/2507.09089) — 経験者 RCT で AI 使用時タスク完了が 19% 遅延
- [FeatureBench (ICLR 2026)](https://arxiv.org/abs/2602.10975) — SWE-bench 74.4% → 複雑な機能開発で 11.0%
- [AI Code Survival in OSS](https://arxiv.org/abs/2601.16809) — AI コードの修正率は 15.8% 低い (HR=0.842)
- [Investigating Autonomous Agent Contributions in the Wild](https://arxiv.org/html/2604.00917v1) — 実環境での自律エージェント活動パターン分析
- [ProdCodeBench: Production-Derived Benchmark](https://arxiv.org/abs/2604.01527) — 実開発者セッション由来。解決率 53.2-72.2%
