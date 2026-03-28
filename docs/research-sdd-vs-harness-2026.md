# SDD vs Harness Engineering Research (2026-03-28)

SDD（Spec-Driven Development）と Harness Engineering の比較調査。両者の設計思想・ツール・併用可能性を分析。

## 1. Harness Engineering（Anthropic 公式）

**出典**: [Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) (2026-03-24, Prithvi Rajasekaran)

### 核心テーゼ

GAN にインスパイアされたマルチエージェント構成で「生成と評価を分離」し、長時間タスクの品質を向上させる。

### 解決する2つの問題

| 問題 | 説明 | モデル依存 |
|------|------|-----------|
| Context anxiety | コンテキスト限界に近づくと早期に作業を切り上げる | Sonnet 4.5 で顕著、Opus 4.6 で大幅改善 |
| 自己評価の失敗 | 「明らかに平凡な出力でも自信を持って称賛する」 | モデル非依存（構造で解決すべき） |

### 3エージェント構成

| Agent | 役割 | 設計ポイント |
|-------|------|-------------|
| **Planner** | 1-4文のプロンプト → 詳細仕様に展開 | 技術設計はハイレベルに留める（詳細指定はエラー伝播の原因） |
| **Generator** | Sprint 単位で実装 | React/Vite/FastAPI/SQLite スタック。自己評価後に handoff |
| **Evaluator** | Playwright MCP で実際にページ操作してスコアリング | 4基準: Design / Originality / Craft / Functionality |

### 性能比較

| 構成 | 時間 | コスト | 結果 |
|------|------|--------|------|
| 単独エージェント | 20分 | $9 | 壊れたゲームプレイ、硬直したワークフロー |
| フルハーネス | 6時間 | $200 | 機能するエディタ・プレイ可能なゲーム・Claude 統合 |

### Opus 4.6 での進化

- Sprint 契約を**削除**しても Planner + Evaluator は維持
- DAW デモ: 3時間50分・$124.70
- Evaluator が Generator の見逃しを検出し続けた → 独立評価の価値はモデル進化で消えない

### 重要な洞察

> モデルが改善されてもハーネスの複雑さは消えない——**移動する**。各コンポーネントは「モデルが単独でできないこと」への仮定をエンコードしている。定期的にストレステストすべき。

---

## 2. SDD（Spec-Driven Development）概要

「仕様を書いてからAIにコードを書かせる」パラダイム。Vibe Coding の対極。

### 3段階のリゴア

| レベル | 説明 | 仕様のライフサイクル |
|--------|------|---------------------|
| **Spec-first** | 仕様がガイド | 実装後は参照しない |
| **Spec-anchored** | 仕様が持続 | 機能進化の基盤になる |
| **Spec-as-source** | 仕様が一次成果物 | コードは生成物。人間はコードを編集しない |

### SDD の一般的ワークフロー

```
Requirements → Design → Tasks → Implementation (TDD)
```

---

## 3. SDD ツール比較

### 3-1. Spec Kit（GitHub 公式）

**リポジトリ**: [github/spec-kit](https://github.com/github/spec-kit) (72.7k stars)

| 項目 | 詳細 |
|------|------|
| ワークフロー | Constitution → Specify → Plan → Tasks → Implement |
| 対応エージェント | 25+ (Claude Code, Copilot, Cursor, Gemini CLI 等) |
| 拡張 | 40+ (Review, Verify, MAQA, Jira/Azure DevOps 連携等) |
| 特徴 | 成果物トレーサビリティ (spec → plan → tasks → impl) |
| CLI | `specify init <project>` でスキャフォールド生成 |

**ワークフロー詳細**:

| Phase | コマンド | 生成物 | 役割 |
|-------|---------|--------|------|
| Constitution | `/speckit.constitution` | `constitution.md` | プロジェクト原則（不変ルール） |
| Specify | `/speckit.specify` | `spec.md` | 何を・なぜ作るか |
| Plan | `/speckit.plan` | `plan.md` | 技術的実装アプローチ |
| Tasks | `/speckit.tasks` | `tasks.md` | アクション可能なタスク分解 |
| Implement | `/speckit.implement` | コード | タスク実行 |

**批評**（Martin Fowler）:
- 冗長な Markdown が生成されレビュー疲れを招く
- 問題サイズに応じたワークフロー調整が不十分
- 「コードをレビューする方がマークダウンをレビューするより良い」

### 3-2. Spec-workflow（Pimzino）

**リポジトリ**: [Pimzino/claude-code-spec-workflow](https://github.com/Pimzino/claude-code-spec-workflow)

| 項目 | 詳細 |
|------|------|
| 対象 | Claude Code 専用 |
| インストール | `npm i -g @pimzino/claude-code-spec-workflow` |
| 特徴 | スラッシュコマンド統合、リアルタイムダッシュボード |

**2つのワークフロー**:

| Feature 開発 | バグ修正 |
|-------------|----------|
| Requirements → Design → Tasks → Implementation | Report → Analyze → Fix → Verify |
| `/spec-create feature-name` | `/bug-create issue-name` |

**主な機能**:

| 機能 | 説明 |
|------|------|
| Steering Documents | `product.md`, `tech.md`, `structure.md` でコンテキスト永続化 |
| 4専用エージェント | task-executor, requirements/design/task-validator |
| コンテキスト最適化 | ドキュメント共有でトークン使用量 60-80% 削減 |
| ダッシュボード | WebSocket + Tailwind CSS、トンネル共有対応 |

**Spec Kit との違い**: Spec Kit が汎用 SDD 基盤なのに対し、spec-workflow は Claude Code のコマンドシステムに深く統合。ダッシュボードやバグ修正ワークフローなど実用機能が充実。

### 3-3. tsumiki（Classmethod, 日本発）

**紹介記事**: [Claude Codeで仕様駆動開発、tsumikiが良かった](https://zenn.dev/hidechannu/articles/20260314-spec-driven-development-tsumiki)

| 項目 | 詳細 |
|------|------|
| ワークフロー | Requirements → Design → Tasks → Implementation (TDD) |
| 対象 | 日本語チーム向け |
| 特徴 | 信号機分類システム、TDD サイクル |

**信号機分類システム**（tsumiki 最大の特徴）:

| 色 | 意味 | 用途 |
|----|------|------|
| 🔵 Blue | 既存文書・実装に基づく確定事項 | そのまま実装可能 |
| 🟡 Yellow | 合理的だが確認が必要な仮定 | 実装前に確認が必要 |
| 🔴 Red | 根拠のない仮定 | 議論・決定が必要 |

**強み**:
- `requirements.md` / `design.md` が自然な日本語フォーマット
- 要件・設計フェーズで徹底的な質問を行い曖昧さを排除
- 実装は Red → Green → Refactor → Verify の TDD サイクル
- 明確な仕様があれば大半は初回実行で完了

**成功の鍵**:
> フレームワークの力は、要件・設計フェーズでの人間の思考の規律から生まれる。曖昧な仕様は AI 能力に関係なく失敗する。

### ツール横断比較

| 観点 | Spec Kit | Spec-workflow | tsumiki |
|------|----------|---------------|---------|
| エコシステム | 汎用 (25+ agent) | Claude Code 専用 | Claude Code 想定 |
| ワークフロー | 5段階 + 拡張 | Feature/Bug の2系統 | 4段階 + TDD |
| 仕様の粒度 | 高（複数ファイル生成） | 中 | 中（信号機で可視化） |
| 独自価値 | 拡張エコシステム | ダッシュボード・CLI統合 | 不確実性の可視化 |
| 弱点 | Markdown 疲れ | Claude Code 依存 | 日本語圏中心 |

---

## 4. Harness Engineering vs SDD: 根本的な設計思想の違い

### 制御の方向が逆

| 観点 | Harness Engineering | SDD |
|------|-------------------|-----|
| **品質の源泉** | 事後の評価ループ（Evaluator） | 事前の仕様精度 |
| **反復モデル** | 生成 → 評価 → 再生成を繰り返す | 仕様 → 一発で正しく実装 |
| **創発性** | 許容（3D CSS 美術館の例） | 仕様に制約される |
| **人間の介入点** | 評価基準の設計 | 仕様の記述 |
| **コンテキスト戦略** | 最小限（集中プロンプトが圧勝） | 重い（複数 Markdown を注入） |
| **前提** | 「仕様は不完全。評価で拾う」 | 「仕様が正しければ実装は成功する」 |

> Harness は「走らせてから正す」、SDD は「正してから走らせる」。

### 併用が困難な3つの理由

#### 1. コンテキスト競合

リサーチが示す通り、コンテキストは少ないほど性能が高い（集中 300tok が 113K tok に圧勝）。SDD の verbose な仕様群が Evaluator ループに必要なコンテキスト枠を圧迫する。

```
SDD の仕様 (requirements.md + design.md + tasks.md)
  + Evaluator の評価基準・過去の反復結果
  = コンテキスト過負荷 → 性能劣化
```

#### 2. 前提の矛盾

- **SDD**: 仕様の精度に投資 → 評価ループを不要にする方向
- **Harness**: 評価ループに投資 → 仕様の不完全さを許容する方向

両方に全力投資するのはコスト的に非合理。

#### 3. 反復速度の衝突

Harness の Evaluator は 5-15 回の反復で品質を上げる。SDD の重い仕様プロセスは各反復のコストを上げ、高速ループを殺す。

---

## 5. 併用可能なスイートスポット

### 仕様 = 評価基準の事前合意（それ以上でもそれ以下でもない）

フル SDD + Harness は厳しいが、**仕様を「Evaluator への判定基準の受け渡し」まで絞れば**補完関係になる。

| アプローチ | 仕様の役割 | 仕様の量 | 評価ループ | 併用可能性 |
|-----------|-----------|---------|-----------|-----------|
| フル SDD | 実装の完全な設計図 | 重い (数百行) | 不要想定 | ❌ 競合 |
| 軽量 SDD + Evaluator | 評価基準の合意 | 軽い (20行以内) | 必須 | ✅ 補完 |
| Harness のみ | なし (Evaluator 基準のみ) | なし | 必須 | ✅ 単独で成立 |

### Anthropic ブログでの実例

Evaluator が Sprint 契約で成功基準を合意 → Generator が実装 → Evaluator が判定。これは本質的に「**最小限の SDD + Evaluator ループ**」。

### qult の位置づけ

| SDD 的要素 | Harness 的要素 |
|-----------|---------------|
| Plan mode（WHAT/WHERE/VERIFY/BOUNDARY/SIZE の5項目） | qult-reviewer（独立 Evaluator） |
| Verify field の具体性検証 | PostToolUse → PreToolUse の二段構え |
| 大 Plan の構造要求 | 評価ループ（reviewer → gate → pending-fixes） |

qult の Plan は仕様ではなく**評価契約**。この粒度が Harness との共存を可能にしている。

---

## 6. 実践的な判断基準

### いつ SDD 寄りにすべきか

- 要件が明確で変更が少ない
- チーム間の合意形成が必要
- 監査・コンプライアンス要件がある
- 1回で正しく作る必要がある（コスト制約）

### いつ Harness 寄りにすべきか

- 要件が曖昧・探索的
- 品質基準が主観的（デザイン、UX）
- 反復コストが低い
- 創発的な解決策を期待する

### 併用する場合の原則

1. **仕様は20行以内** — コンテキスト枠を守る
2. **仕様 = WHAT、評価 = HOW** — 仕様で「何を達成すべきか」、Evaluator で「達成できたか」を判定
3. **仕様の粒度 ∝ タスクの規模** — 小タスクに重い仕様は不要
4. **Evaluator の判定基準に仕様を使う** — 仕様を Generator に渡すのではなく Evaluator に渡す

---

## 7. 業界動向: 3つのパラダイムの進化と世間の論調

### パラダイムの進化タイムライン

| フェーズ | 時期 | メタファー | 焦点 |
|---------|------|-----------|------|
| **Prompt Engineering** | 2022-2024 | 完璧なメールを書く | 入力の最適化 |
| **Context Engineering** | 2025 | メールに正しい添付ファイルを付ける | コンテキストの構築 |
| **Harness Engineering** | 2026 | オフィス全体を設計する | 実行環境・制約・フィードバックループ |

出典: [Epsilla: The Third Evolution](https://www.epsilla.com/blogs/harness-engineering-evolution-prompt-context-autonomous-agents)

SDD は本質的に Context Engineering の延長（仕様 = 構造化されたコンテキスト）。Harness Engineering とは抽象度が異なる。

### Vibe Coding → SDD → Harness の流れ

```
Vibe Coding ──→ SDD ──→ Harness Engineering
(自由すぎる)    (硬すぎる)  (制約で品質を出す)
```

- **Vibe Coding** = スケッチ。速いがスケールしない（3ヶ月で技術的負債が爆発）
- **SDD** = ブループリント。Vibe Coding へのダメージコントロールとして登場
- **Harness Engineering** = 建設現場。仕様の重さに頼らず実行時の制約で品質を担保

### SDD への批判（世間の声）

#### 「Waterfall の再来」論

- [Marmelab](https://marmelab.com/blog/2025/11/12/spec-driven-development-waterfall-strikes-back.html): 「SDD は V モデルを復活させアジリティを殺す」
- [Roger Wong](https://rogerwong.me/2026/03/spec-driven-development): 「構造的に Waterfall に似ている。ただしサイクルが分→月に短縮された点が決定的に違う」→ 「agile wearing a trench coat（トレンチコートを着たアジャイル）」
- Wong 自身も「仕様がプロジェクト時間の50%を食い、スケールで破綻した」事例を紹介

#### レビュー疲れ

- [Martin Fowler](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html): Kiro が単純なバグに4ユーザーストーリー・16受入基準を生成。「コードをレビューする方がマシ」
- [Prezi Engineering](https://engineering.prezi.com/we-tried-spec-driven-development-so-you-dont-have-to-56d52231c19e): 「試したので皆さんは試さなくていい」— タイトルが全てを物語る

#### 限界論

- [C-DAD 提唱者](https://medium.com/software-architecture-in-the-age-of-ai/why-spec-driven-development-has-reached-its-limit-6e9bfed9ee13): 「SDD は構造を自動化するが理解は自動化しない。仕様はデプロイ後すぐに陳腐化する凍結文書」→ 代替として Contract-Driven AI Development（実行時に自己検証する生きた契約）を提案
- [INNOQ](https://www.innoq.com/en/blog/2026/03/sdd-ddd-why-bmad-wont-save-you/): 「SDD は DDD のせっかちな従兄弟」

#### セマンティック拡散

- Thoughtworks / Martin Fowler: 「spec」が「詳細なプロンプト」の同義語になりつつあり、SDD という用語自体の意味が希薄化

### Harness Engineering への支持

#### 実績データ

| 事例 | 成果 | 出典 |
|------|------|------|
| ベンチマーク | 同じモデル・同じデータでハーネスだけ変えて **42% → 78%** | [Epsilla](https://www.epsilla.com/blogs/harness-engineering-evolution-prompt-context-autonomous-agents) |
| Stripe Minions | 週 1,300+ PR を自律マージ。ハーネスが CI/テスト/スタイル/ドキュメントを管理 | [Philipp Schmid](https://www.philschmid.de/agent-harness-2026) |
| OpenAI Codex チーム | 7人が GPT-5 エージェントで 100万行・1,500 PR を生成 | [Epsilla](https://www.epsilla.com/blogs/harness-engineering-evolution-prompt-context-autonomous-agents) |
| Anthropic DAW デモ | 3時間50分・$124.70 で機能するアプリ。Evaluator が品質ギャップを検出し続けた | [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps) |

#### 核心的な洞察

- [Philipp Schmid](https://www.philschmid.de/agent-harness-2026): 「エージェントは難しくない。**ハーネスが難しい**」
- Anthropic: 「自己評価を厳しくするより、独立した評価エージェントを厳しく設計する方が**はるかに容易**」
- Harness = OS、Model = CPU、Context = RAM というアナロジーが広まっている
- Bitter Lesson の適用: 軽量でモデル世代をまたぐインフラが、過剰に設計されたソリューションより長持ちする

### 中立的な立場

- [Alex Cloudstar](https://www.alexcloudstar.com/blog/spec-driven-development-2026/): 「SDD を未来と宣言するのも Waterfall 2.0 と切り捨てるのも間違い。現実はもっと雑然としていて実用的」
- [DevOps.com](https://devops.com/vibe-coding-vs-spec-driven-development-finding-balance-in-the-ai-era/): 「Vibe/SDD/Harness は代替ではなくレイヤー。いつ切り替えるかを知ることが重要」

### 今後の見通し

「SDD が死ぬ」というより、**SDD の有用な部分（軽い仕様 = 評価基準の合意）が Harness に吸収される**方向。

| 消える部分 | 残る部分 |
|-----------|---------|
| 重い requirements.md / design.md | 軽量な成功基準の事前合意 |
| 仕様 → 一発実装の前提 | 仕様 = Evaluator の判定基準 |
| Markdown レビューの儀式 | コードレビュー + 自動ゲート |
| 仕様メンテナンスコスト | 使い捨ての評価契約 |

---

## Sources

### Harness Engineering
- [Anthropic: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Epsilla: The Third Evolution (Prompt → Context → Harness)](https://www.epsilla.com/blogs/harness-engineering-evolution-prompt-context-autonomous-agents)
- [Philipp Schmid: Agent Harness 2026](https://www.philschmid.de/agent-harness-2026)
- [OpenAI: Harness Engineering with Codex](https://openai.com/index/harness-engineering/)

### SDD ツール
- [GitHub Spec Kit](https://github.com/github/spec-kit)
- [Pimzino/claude-code-spec-workflow](https://github.com/Pimzino/claude-code-spec-workflow)
- [tsumiki で仕様駆動開発 (Zenn)](https://zenn.dev/hidechannu/articles/20260314-spec-driven-development-tsumiki)

### SDD 批評・分析
- [Martin Fowler: SDD Tools (Kiro, spec-kit, Tessl)](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)
- [Alex Cloudstar: SDD 2026 — Future or Waterfall?](https://www.alexcloudstar.com/blog/spec-driven-development-2026/)
- [Roger Wong: SDD Looks Like Waterfall (And I Feel Fine)](https://rogerwong.me/2026/03/spec-driven-development)
- [Marmelab: The Waterfall Strikes Back](https://marmelab.com/blog/2025/11/12/spec-driven-development-waterfall-strikes-back.html)
- [Prezi Engineering: We Tried SDD So You Don't Have To](https://engineering.prezi.com/we-tried-spec-driven-development-so-you-dont-have-to-56d52231c19e)
- [INNOQ: SDD is DDD's Impatient Cousin](https://www.innoq.com/en/blog/2026/03/sdd-ddd-why-bmad-wont-save-you/)
- [C-DAD: Why SDD Has Reached Its Limit](https://medium.com/software-architecture-in-the-age-of-ai/why-spec-driven-development-has-reached-its-limit-6e9bfed9ee13)
- [Thoughtworks: Unpacking SDD](https://www.thoughtworks.com/en-us/insights/blog/agile-engineering-practices/spec-driven-development-unpacking-2025-new-engineering-practices)

### リサーチ基盤
- [SDD: Code to Contract (arXiv)](https://arxiv.org/abs/2602.00180)
- [TDAD: Test-Driven Agentic Development](https://arxiv.org/abs/2603.17973)
- [Context Rot (Chroma)](https://www.trychroma.com/research/context-rot)
