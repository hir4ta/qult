# alfred v0.9.2 徹底評価 (2026-03-27)

Anthropic "Harness Design for Long-Running Apps" (2026-03-24) を一次ソースとし、
全コンポーネントの load-bearing 判定、閾値の研究根拠、コスト分析を実施。

裏付けの強さ: **事実** (一次ソース引用可能) / **推測** (根拠はあるが直接証拠なし) / **意見** (自分の解釈)

## 総合スコア: B+ (80/100)

| 評価軸 | スコア | 評価 |
|---|---|---|
| 設計の理論的裏付け | A (90) | リサーチ駆動。主要設計判断に一次ソースあり |
| 実装品質 | A- (87) | fail-open、atomic write、型安全。堅実 |
| 実際の性能向上への寄与 | B (75) | Gate enforcement は確実。他は未検証 |
| Opus 4.6 への適応 | B+ (80) | sprint緩和は適切。だが過剰制御の残滓あり |
| 実運用での費用対効果 | B- (72) | 全コミットにOpusレビューは高コスト |
| 保守性・拡張性 | A- (85) | ゼロ依存、明確な分類、テスト充実 |

---

## 確実に効く部分 (事実ベース)

### 1. Gate Enforcement (lint/type/test)

**事実**: Claude Code は lint エラーを放置して次のファイルに進む。`PostToolUse → pending-fixes → PreToolUse DENY` の二段構えがこれを機械的に防止する。

- Anthropic記事: 「self-evaluation は信頼できない」→ 客観ゲートが最適解
- additionalContext (advisory) ではなく exit 2 (DENY) を使う判断は正しい
- **最も load-bearing なコンポーネント**

### 2. 独立 Evaluator (alfred-reviewer)

**事実**: Anthropic記事の核心 — 「Separating the working agent from the judging agent proves highly effective」

- Opus モデルで独立実行
- Anti-self-persuasion 指示 + few-shot 3例 + S/A/A フィルタ
- HubSpot 2-stage パターン (Reviewer → Judge) と整合
- 記事: 「few-shot calibration with detailed score breakdowns ensured evaluator alignment」

### 3. Fail-Open 設計

**事実**: 全 hook が try-catch wrap。alfred の障害が Claude を止めない。

- dispatcher.ts: 入力 >5MB 拒否、JSON パース失敗のグレースフル復帰
- 全 state read: missing file → default return
- プロダクション品質の判断

### 4. Context Budget 制御

**事実**: advisory 応答に 2000 token/session の予算制限。

- リサーチ: 「30K トークンで推論 -47.6% 劣化」(Context length研究)
- 「300 tokens concentrated > 113K diffuse」(Chroma Research)
- **推測**: 2000 token という数値自体の最適性は未検証だが方向性は正しい

---

## Advisory Hook の Load-Bearing 判定

| Hook | Load-Bearing? | トークン | 根拠 |
|---|---|---|---|
| user-prompt.ts (Plan template) | **YES** | 100-220 | 削除すると大Plan構造検証(permission-request)のDENY増加。TDAD論文「107→20行で4x解決率」 |
| session-start.ts (Error trends) | **NO** | 50-150 | 情報提供のみ。ゲートは別途実行される |
| subagent-start.ts (Pending-fixes) | **YES** | 100-200 | サブエージェントがpending-fixesのedit制限を知らないとカスケード障害 |
| post-tool-failure.ts (/clear提案) | **NO** | 50-80 | QoLのみ。Anthropic推奨「2回失敗→/clear」の提案だが強制ではない |
| pre-compact.ts (reminder) | **NO** | 0 (stderr) | stderr出力でモデルに到達しない。ユーザー向け診断のみ |

**結論**: 5つの advisory hook のうち load-bearing は 2つ (user-prompt, subagent-start)。残り3つは削除しても品質に直接影響しない。ただしコストも低い (stderr or budget内) ため、積極的に削除する理由も薄い。

---

## Pace 閾値の研究根拠

| パラメータ | 値 | 研究根拠 | 信頼度 |
|---|---|---|---|
| DEFAULT_RED_MINUTES | 120 | **研究なし**。「Opus 4.6の長時間作業対応」としてCLAUDE.mdに記載あるがソースなし | 低 |
| DEFAULT_FILES | 15 | **研究なし**。SWE-bench「1-2ファイル/タスク」からの外挿と推測されるが、SWE-benchデータはLOCベースであり経過時間とは無関係 | 低 |
| 適応乗数 (×2) | avgMinutes × 2 | **ヒューリスティック**。×2の根拠不明。×1.5でも×3でもなく×2である理由がない | 中 |
| Plan乗数 (×1.5) | threshold × 1.5 | **論理的だが未検証**。Planはスコープが大きいので猶予という推論 | 中 |

**結論**: Pace閾値は**全てヒューリスティック**。Anthropic記事は時間ベースの制限について一切言及していない。効果測定のために閾値を変えた A/B テストが必要。

---

## Plan 構造要件の必要性

### 小Plan (≤3 tasks) → 検証は冗長

**推測**: Opus 4.6は小タスクを自律的に処理可能。Anthropic記事: 「sprint structure を完全に削除した」(Opus 4.6)。現状の小Plan緩和は妥当だが、そもそも小Planの Verify チェックすら不要かもしれない。

### 大Plan (4+ tasks) → **Load-bearing**

以下の理由で構造要件は必要:

1. `post-tool.ts` の `checkVerifyFields()` が Verify フィールドに依存してテスト出力を検証
2. `stop.ts` がタスク数で enforcement レベルを分岐 (block vs warn)
3. Martin Fowler: 「agents frequently ignored verbose specs」→ Success Criteria 質検証で防止
4. **Verify フィールドの具体性要件は必須** — 削除すると post-tool.ts のテスト検出が機能停止

### ただし Opus 4.6 で不要になった可能性も否定できない

**事実**: Anthropic記事は「every component encodes an assumption about what the model can't do...worth stress testing」と述べている。大Planの構造要件を外して品質が落ちるかの検証が次ステップ。

---

## レビュー強制のコスト分析

### 現状: 全コミットに無条件強制

```
pre-tool.ts: git commit → readLastReview() がnull → DENY
stop.ts: finish → readLastReview() がnull → BLOCK
```

### コスト

- Opus reviewer 1回: ~$0.10-0.25 (5,000-12,500 tokens)
- 5コミット/セッション: $0.50-1.25
- skill-review.md 自体が「NOT for trivial changes (typo, rename, log line)」と記載

### Anthropic記事との矛盾

**事実**: 記事は明確に述べている — 「evaluators aren't binary decisions but cost-benefit analyses depending on task complexity relative to current model capabilities」「on easier tasks, the evaluator represented overhead」

**現状のalfredはこれに反している**: 1行の typo 修正でも Opus reviewer を起動する。

### 改善提案 (意見)

変更規模に応じた閾値を導入:
- 例: diff 50行未満 かつ 3ファイル以下 → レビュースキップ可能
- スキップ時は metrics に `review:skipped` を記録
- 大きな変更は従来通り強制

---

## Anthropic 記事との対照表

| 記事の知見 | alfred の対応 | 評価 |
|---|---|---|
| 自己評価は機能しない | alfred-reviewer (独立Opus) | **適切** |
| evaluator calibration に few-shot 必要 | 3 examples + scoring rubric | **適切** |
| Sprint contract → Opus 4.6 で削除 | 緩和したが完全削除せず | **やや過剰** |
| Context reset > compaction | PostCompact で代替 (API制約) | **次善策** |
| Evaluator は cost-benefit | 全コミットに強制 | **過剰** |
| 全コンポーネントは仮定 → stress test | metrics はあるが A/B なし | **不十分** |
| 簡単なタスクに evaluator は overhead | 閾値なし | **未対応** |
| File-based communication | pending-fixes.json 等 | **適切** |
| One feature at a time | Pace + task scope enforcement | **適切** |

---

## 発見された問題: Session State の越境永続化

### 症状

新セッション開始時に前セッションの pending-fixes が Stop hook をブロック。

### 根本原因

- `pending-fixes.json` がセッション間で永続化
- `session-start.ts` に pending-fixes クリアロジックがない
- `dispatcher.ts` は `resetBudget()` のみ実行 (pending-fixes は対象外)
- `clearOnCommit()` も pending-fixes を対象外にしている

### 影響

新会話で即座に Stop hook ブロック → ユーザー体験の劣化。

---

## 未対応の改善項目 (優先順)

1. **Session state 越境問題の修正** — session-start.ts で pending-fixes クリア ✅ v0.9.3 で対応済み
2. **レビュー閾値の導入** — 変更規模に応じたスキップ機構 ✅ v0.9.4 で対応 (Plan or 5+ファイル → 強制、それ以外 → 任意)
3. **A/B テスト基盤** — alfred有無の比較データ取得
4. **Sprint contract 完全削除テスト** — 大Plan要件を外して品質測定
5. **Advisory hook 効果測定** — respond-skipped 率の実測

---

## 一言で

Gate enforcement + 独立 evaluator は**確実に価値がある**。ただし「全コンポーネントが load-bearing か」の検証が不足。Anthropic記事が警告する「every component encodes an assumption — stress test regularly」の実践が次の課題。**足し算は終わった。次は引き算のフェーズ。**
