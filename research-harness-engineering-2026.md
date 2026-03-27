# Harness Engineering Research (2026-03-26)

Claude Code の性能を最大化するハーネス設計のリサーチ結果。

## 1. タスクサイズと成功率

| タスク規模 | 成功率 | 出典 |
|---|---|---|
| Easy (<=5 LOC, 1ファイル) | 80%+ | SWE-bench Verified |
| Medium (~14 LOC, 1-2ファイル) | 62% | SWE-bench Verified |
| Hard (55+ LOC, 2+ファイル) | 20-25% | SWE-bench Verified |
| 12 LOC超 or 150語超プロンプト | 60%がゴミコード | Code gen benchmarks |

**結論**: 15行以下・単一ファイルに保てば80%成功。これを超えると急激に劣化。

## 2. コンテキストの質

| 知見 | 数値 | 出典 |
|---|---|---|
| 集中プロンプト(300tok) vs フル(113K tok) | 集中が圧勝 | Chroma Research |
| 30Kトークンでの推論劣化 | -47.6% (HumanEval) | Context length研究 |
| 80%コンテキスト充填からの劣化 | 45%の一貫性低下 | SFEIR/SitePoint |
| CLAUDE.mdの指示予算 | 100-150個が限界 | HumanLayer |
| 20xプロンプト圧縮 | 1.5%の性能低下のみ | LLMLingua (Microsoft) |
| Lost in the Middle | 中間の情報は失われる (U字カーブ) | Liu et al. Stanford |

**結論**: コンテキストは少ないほど良い。必要な情報だけを先頭と末尾に置く。

## 3. 検証ループ

| 知見 | 数値 | 出典 |
|---|---|---|
| 「テストを先に書け」と指示 | リグレッション+42%悪化 | TDAD論文 |
| 「どのテストを確認すべきか」を提供 | リグレッション-70%改善 | TDAD論文 |
| Self-Refine (1-2回反復) | 5-40%改善 | Self-Refine研究 |
| 3回以上の反復 | 収穫逓減 | Self-Refine研究 |
| スキル定義107行→20行 | 解決率4倍 | TDAD論文 |

**結論**: HOWではなくWHATを伝える。反復は1-2回が最適。指示は短いほど効く。

## 4. Plan (設計書) の最適形式

### やってはいけないこと
- 冗長な仕様書 (Martin Fowler: agents frequently ignored verbose specs)
- HOWの詳細指定 (TDAD: 手続き的TDD指示はリグレッション+42%)
- モノリシックPRD (GitHub 2,500+リポ: spec-per-fileが優位)

### やるべきこと
1. **WHAT**: 何を作るか (振る舞いベース)
2. **WHERE**: どのファイルを触るか (1ファイルが理想)
3. **VERIFY**: どのテストで検証するか (具体的なテストファイル名・関数名)
4. **BOUNDARY**: 何をしてはいけないか
5. **SIZE**: 15行以下の変更に収める

## 5. 実装フローの最適解

1. **Plan と Execution を分離** (Aider Architect/Editor: well-formed edits 92%→100%)
2. **1タスク = 1コンテキスト** (Sourcegraph: compaction < hand-off)
3. **「どうやるか」ではなく「何を検証するか」を伝える** (TDAD: -70% regression)
4. **2回失敗したら/clear** (Anthropic公式推奨)
5. **出力はフィルタリング** (passing output swallow, failures only surface)
6. **指示は20行以内** (TDAD: 107→20行で4x解決率)

## 6. ハーネスアーキテクチャの知見

### Anthropic公式 (3記事)

**Harness Design for Long-Running Apps**:
- 3エージェント (Planner / Generator / Evaluator)
- 自己評価は信頼できない → 独立した評価エージェントが必要
- コンテキストリセット > コンパクション
- スプリント契約: 実装前に「完了」の定義を合意

**Effective Harnesses for Long-Running Agents**:
- Feature list as JSON (200+ discrete features, each with verification steps)
- 1セッション = 1機能が最大
- ファイルベース通信プロトコル

**Building Effective Agents**:
- Evaluator-Optimizer パターン: 明確な評価基準があるときに最も効果的
- シンプルから始めて必要なときだけ複雑に

### SWE-bench トップ実装
- bash + system prompt だけの最小ハーネスが最強 (78%+)

### Cursor / Aider
- Plan before code
- Fresh conversations per task
- Architect/Editor 分離
- Tests allow the agent to iterate against a clear target

## 7. Claude Code Hook システム

### 全24イベント (主要なもの)
| Event | ブロック可? | 用途 |
|---|---|---|
| SessionStart | No | 初期コンテキスト注入 |
| UserPromptSubmit | Yes | プロンプト前処理 |
| PreToolUse | Yes (allow/deny/ask) | ツール実行前ゲート |
| PostToolUse | Yes (feedback) | ツール実行後フィードバック |
| Stop | Yes (force continue) | 停止前チェック |
| PreCompact | No | コンパクション前保存 |
| TaskCompleted | Yes | タスク完了時検証 |

### ハンドラータイプ (4種)
1. **command**: シェルコマンド (stdin JSON, 600sタイムアウト)
2. **http**: POST (30s)
3. **prompt**: 単発LLM呼び出し (Haiku, 30s)
4. **agent**: マルチターンサブエージェント (60s, 50ツール回)

### 重要な制約
- Exit 2 = ブロック (stderr表示, JSON無視)
- Exit 0 = 通過 (stdout JSON解析)
- additionalContext = advisory (Claudeは無視可能)
- permissionDecision: deny = 100%ブロック
- PostToolUse block = ツールは既に実行済み (取り消し不可)

### 公式にはDIRECTIVE/WARNING/CONTEXTの区別はない
additionalContextは一律advisory。唯一の強制はexit 2とpermissionDecision: deny。

## 8. Context Reset vs Compaction (Anthropic Harness Design 2026-03-24)

| アプローチ | 効果 | 出典 |
|---|---|---|
| Compaction (要約して継続) | context anxiety が残存 | Anthropic Harness Design |
| Context reset (新agent + 構造化handoff) | 両方の問題を解消 | Anthropic Harness Design |
| Opus 4.6 | context resetの必要性を軽減 | Anthropic Harness Design |

**知見**:
- "Claude Sonnet 4.5 exhibited context anxiety strongly enough that compaction alone wasn't sufficient"
- Context reset = コンテキスト全消去 + 前agentの状態と次ステップの構造化引き継ぎ
- 独立evaluatorが最強のレバー: "Separating the agent doing the work from the agent judging it"
- Self-evaluation は信頼不可: "Claude responds by confidently praising the work—even when the quality is obviously mediocre"
- Evaluator calibration に数ラウンド必要: few-shot + 判断基準の明示
- Sprint contract は Opus 4.6 で削除 (モデル進化で不要に)
- "Every component encodes an assumption about what the model can't do...worth stress testing"

**qultへの適用**:
- Context reset はClaude Code hook APIでは不可能 (agent handoff を制御する手段なし)
- 代替: PostCompact で構造化handoff (全クリティカル状態の再注入) を実装
- 独立evaluator: qult-reviewer (Opus) + Judge filter (S/A/A)
- Sprint contract: 小Plan緩和 + 大Plan構造要求 (Opus 4.6適応)

## 9. CLAUDE.md 最適化

- 300行以内 (理想は60行以下)
- 各行に「これがないとClaudeがミスするか？」テスト
- 具体的なコマンド + コード例 > 抽象的なルール
- @import で分割ロード
- コンパクション後にCLAUDE.mdの指示は失われうる

## Sources

- [Anthropic: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic: Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic: Demystifying Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [SWE-bench Verified Analysis](https://jatinganhotra.dev/blog/swe-agents/2025/04/15/swe-bench-verified-easy-medium-hard.html)
- [TDAD: Test-Driven Agentic Development](https://arxiv.org/abs/2603.17973)
- [Self-Refine](https://selfrefine.info/)
- [Context Rot (Chroma)](https://www.trychroma.com/research/context-rot)
- [Lost in the Middle](https://arxiv.org/abs/2307.03172)
- [Context Length Hurts Performance](https://arxiv.org/html/2510.05381v1)
- [LLMLingua (Microsoft)](https://github.com/microsoft/LLMLingua)
- [Multi-Agent Scaling Laws](https://arxiv.org/abs/2512.08296)
- [Addy Osmani: Good Spec for AI Agents](https://addyosmani.com/blog/good-spec/)
- [GitHub: 2,500+ agents.md](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/)
- [Martin Fowler: Spec-Driven Development](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)
- [Aider: Architect/Editor](https://aider.chat/2024/09/26/architect.html)
- [HumanLayer: Skill Issue](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [HubSpot: Automated Code Review](https://product.hubspot.com/blog/automated-code-review-the-6-month-evolution)
- [Sourcegraph: Retires Compaction](https://tessl.io/blog/amp-retires-compaction-for-a-cleaner-handoff-in-the-coding-agent-context-race/)
- [Factory.ai: Evaluating Compression](https://factory.ai/news/evaluating-compression)
- [DORA 2025 Report](https://dora.dev/research/2025/dora-report/)
- [Cursor: Agent Best Practices](https://cursor.com/blog/agent-best-practices)
- [Agentless (SWE-bench)](https://arxiv.org/abs/2407.01489)
