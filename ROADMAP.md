# alfred ロードマップ

## 完了済みバージョン

| Version | テーマ | 主要成果 |
|---|---|---|
| v0.1.0 | 13 Hooks ベースライン | 壁 + Plan増幅 + 実行ループ + サブエージェント制御 + 防御。83テスト |
| v0.2.0 | dogfooding + 品質基盤 | doctor, run_once_per_batch, SubagentStop 検証, Bun依存除去 |
| v0.3.0 | Plan-Execution 整合性 | テスト検証自動化, ExitPlanMode 詳細検証, Phase Gate, 独立レビュー強制 |
| v0.4.0 | コンテキスト最適化 | 2000トークン予算, 動的 Plan テンプレート (Short/Medium/Large) |
| v0.5.0 | 学習と適応 | gate トレンド分析, Pace 適応閾値, 頻出エラー注入 |

---

## v0.5.1 現状評価 (2026-03-27)

### 総合スコア: 72 / 100

Anthropic 公式 Harness Design 記事 (2026-03-24) を評価基準とした採点。

### 評価基準

記事の核心原則:
1. 3エージェント構造 (planner / generator / evaluator) — 分離が品質を生む
2. Context reset > Compaction — clean slate + 構造化 handoff
3. 自己評価バイアス — Claude は自分の仕事を褒める。独立 evaluator 必須
4. load-bearing component — 全コンポーネントは「モデルが単独でできないこと」の仮定。仮定は陳腐化する
5. Simplest solution possible — 複雑性は必要な時だけ追加
6. Evaluator チューニングが本質 — 素の Claude は QA が下手
7. One feature at a time — 1機能ずつ実装
8. Sprint contract — 実装前に成功基準を交渉

### カテゴリ別スコア

| カテゴリ | スコア | 評価 |
|---|---|---|
| 設計思想 | 88 | リサーチ駆動、fail-open、壁>情報提示 — 記事の原則とほぼ完全一致 |
| 強制力 (DENY/block) | 82 | 二段構え gate は evaluator 分離原則の hooks 実装として正当 |
| 独立レビュー | 78 | 記事の最重要原則を実装。構造は正しい。チューニングが不足 |
| タスクサイズ制御 | 80 | 「one feature at a time」の数値実装 (1 file, 15 lines) |
| fail-open 設計 | 85 | 「simplest solution」原則の忠実な実装 |
| load-bearing 妥当性 | 75 | 14 hooks 中 11 が Opus 4.6 でもまだ有効 |
| Plan 制御 | 70 | sprint contract 相当。テンプレは良い。同期の脆さが残る |
| Handoff | 60 | 方向は正しい。中身が薄い。Opus 4.6 で重要度低下 |
| テスト | 60 | unit は良い。integration がない |
| 状態管理 | 48 | 10 JSON 散在、回復手段なし、測定不能 |

### 強み

#### 1. evaluator harness として正しい構造

alfred は planner harness ではなく **evaluator harness**。記事の 3 エージェント構造のうち:

```
          Generator → Evaluator (gates + reviewer)
              ^____________|  (pending-fixes → DENY → 修正)
```

PostToolUse(検出) → PreToolUse(DENY) の二段構えは、Claude 自身ではなく外部プロセス (biome/tsc) が評価し、失敗なら物理的にブロックする。記事の「自己評価は機能しない → 独立 evaluator 必須」を hooks レベルで実装。

#### 2. CLAUDE.md では不可能な強制力

世のSDD/harnessツールの大半は advisory (お願い)。Claude が無視すれば終わり。exit 2 による物理ブロックは少数派の正しいアプローチ:

- pending-fixes DENY — lint エラー放置で次ファイル編集を物理阻止
- test-before-commit — テスト未実行でコミットを物理阻止
- review-before-stop — レビュー未実行で完了宣言を物理阻止
- ConfigChange DENY — hook 設定削除を物理阻止

#### 3. リサーチ駆動の設計判断

全設計判断に SWE-bench、Anthropic 公式記事、Self-Refine 論文等の裏付け。「15 lines / 1 file」はSWE-bench (≤5 LOC = 80%+ 成功率)。独立レビューは Anthropic 記事の evaluator 分離。2000トークン予算は「30K tokens = -47.6% degradation」研究。

#### 4. fail-open 哲学

全 hooks が try-catch で握りつぶし。harness の障害で Claude を止めない。記事が警告する「harness 自体がボトルネック」リスクを回避。

#### 5. 競合に対する差別化

| vs | alfred の優位性 |
|---|---|
| spec-kit / tsumiki / cc-sdd | 強制力。advisory ではなく exit 2 で物理ブロック |
| spec-workflow | gate 自動検出 + pending-fixes 追跡 |
| GSD v1 | ランタイム enforcement |
| ECC (110K stars) | focused。108 skills より 14 hooks の方が予測可能 |

### 弱み

#### 1. 効果測定がない (最大の弱点)

「性能を倍増させる」と主張するなら、何をもって倍増か？ gate の DENY が実際に悪いコードを防いだか、Plan テンプレートが Plan の質を上げたか、additionalContext を Claude が消費したか — いずれも未計測。改善の方向すら分からない。

#### 2. additionalContext の大半は無駄

14 hooks のうち exit 2 を使うのは 5 つだけ。残りは全て additionalContext = advisory。Claude は advisory を約50%の確率で無視する (特にコンテキストが深い時)。2000トークンの予算管理は正しい方向だが、そもそも届いていないメッセージの予算を管理しても意味がない。

#### 3. Planner フェーズが弱い

記事の 3 エージェント構造で planner が全体品質を決める。alfred は Plan テンプレート注入だけで、本格的な planner agent は不在。Sprint contract (実装前に evaluator と成功基準を交渉) もない。

#### 4. Evaluator (reviewer) のチューニング不足

記事: 「Out of the box, Claude is a poor QA agent. I watched it identify legitimate issues, then talk itself into deciding they weren't a big deal and approve the work anyway.」

alfred の reviewer agent は汎用プロンプトのみ。few-shot 例、スコア基準の明示、calibration がない。構造は正しいがチューニングが足りない。

#### 5. 状態管理の散在と回復不能

10個の JSON ファイルが .alfred/.state/ に散在。single source of truth なし。壊れた状態からの回復手段 (`alfred reset-state`) がない。fail-open で壊れた JSON を黙殺するため、デバッグ不能。

#### 6. task-completed 同期の脆さ

fuzzy match が雑すぎる (推定40%サイレント失敗)。ExitPlanMode の正規表現も case-sensitive で脆い。Plan の「構造」は検証するが「質」は見ていない (空 Verify フィールドが通る)。

#### 7. Handoff の中身が薄い

記事は「handoff artifact に十分な状態を持たせよ」と述べるが、alfred の handoff は `summary: "Session in progress"`, `pending_fixes: boolean` 程度。Plan コンテキスト、gate エラー詳細、進行中のコードが含まれない。

#### 8. Integration テスト不在

テストは全てモック gate (`echo 'OK' && exit 0`)。実際の biome/tsc/vitest での統合テストがない。マルチセッション (compaction → recovery) のテストもない。

### load-bearing 分析

各コンポーネントが encode する「モデルが単独でできないこと」の仮定と、Opus 4.6 での妥当性:

| コンポーネント | 仮定 | まだ有効？ |
|---|---|---|
| pending-fixes DENY | lint エラーを無視して次ファイルに行く | **Yes** — 確実に起きる |
| test-before-commit | テストなしでコミットする | **Yes** — 頻繁に起きる |
| review-before-stop | 自己レビューで満足する | **Yes** — 記事が明示的に確認 |
| Plan テンプレート | 構造化 Plan を自力で書けない | **Partial** — Opus 4.6 で改善中だが Verify は自発的に書かない |
| Pace 追跡 | 長時間コミットせずに作業する | **Yes** — context rot の原因 |
| SubagentStart ルール注入 | サブエージェントは品質ルールを知らない | **Yes** — CLAUDE.md を継承しない |
| ConfigChange DENY | hook 設定を削除する | **Rare** — 稀だが致命的。保険として合理的 |
| Context budget | 注入しすぎると性能が落ちる | **Yes** — 記事も context 品質を重視 |
| Handoff (3 hooks) | Compaction で文脈が失われる | **Weakening** — Opus 4.6 の自動 compaction で頻度低下 |
| Gate トレンド注入 | 同じエラーを繰り返す | **Weak** — advisory なので効果が不明 |

14 hooks 中 11 がまだ load-bearing。Handoff 関連 3 hooks は陳腐化リスクあり。

### 競合比較

| ツール | Stars | 強制力 | SDD Workflow | alfred との関係 |
|---|---|---|---|---|
| spec-kit (GitHub) | 82K | なし (advisory) | Yes | **補完** — planning + alfred enforcement |
| ECC | 110K | あり (exit 2) | Partial | **競合** — 広く浅い vs 狭く深い |
| GSD | 42K | v2のみ | Yes | **補完** — context rot 対策 + alfred gates |
| spec-workflow | 3.6K | 弱 | Yes | **補完** — steering docs + alfred enforcement |
| tsumiki | 930 | なし | Yes (TDD) | **補完** — TDD workflow + alfred gates |
| claude-code-harness | 327 | あり (13 rules) | Plan→Work→Review | **最近競合** — 同哲学、並列ワーカーで差 |

**結論**: alfred と SDD ツールは競合ではなく補完関係。alfred は「どう作るか (execution quality)」を制御し、SDD は「何を作るか (planning)」を制御する。

---

## v0.5.2 (完了)

Hook スキーマバグ修正 + ドキュメント刷新。

- **Stop hook**: `hookSpecificOutput.additionalContext` → stderr (スキーマ未対応)
- **SessionStart hook**: `respond()` 2回呼び出し → 1回に統合 (JSON連結バグ)
- **user-prompt テスト**: cwd 未隔離で実プロジェクトの枯渇 budget を読んでいた → tmp dir 隔離
- **ROADMAP.md**: v0.5.1 評価 (72/100) + v0.6.0 ロードマップに全面書き換え
- **README.md**: 「evaluator harness」コンセプトに刷新

## v0.5.3 (完了)

公式ドキュメント準拠の hookSpecificOutput.additionalContext 対応表に基づく修正。

- **PostCompact**: `respond()` → stderr (additionalContext 未サポート)
- **TaskCompleted**: `respond()` → stderr (additionalContext 未サポート)
- **CLAUDE.md**: additionalContext 対応表を追記
- 裏付け: https://code.claude.com/docs/en/hooks で全 hook event の出力スキーマを確認
- respond() 使用可: SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, SubagentStart
- respond() 使用不可: Stop, PostCompact, TaskCompleted, PreCompact, SessionEnd, ConfigChange

---

## v0.6.0 — Evaluator 強化 + 効果測定

v0.5 までの「構造は正しいが効果が不明」を解消する。記事の 2 つの原則に集中:
1. **Evaluator チューニング** — 「素の Claude は QA が下手」→ calibration
2. **load-bearing 監査** — 「仮定は陳腐化する」→ 効果測定

### 6.1 効果測定基盤 (metrics)

**Why**: 最大の弱点。DENY が何を防いだか、advisory が消費されたか、全て未計測。改善の方向すら分からない。

**設計:**
- `src/state/metrics.ts` — DENY/block/respond の発火を記録
  - `{ event, action: "deny"|"block"|"respond", reason, timestamp }`
  - 50件 cap (gate-history と同じ)
- `alfred doctor --metrics` — 直近 50 件の統計表示
  - DENY 発火回数 (by reason)
  - advisory 注入回数 vs 予算超過スキップ回数
  - 平均コミット間隔
- respond/deny/block 関数に 1行追加するだけ。既存ロジック変更なし

### 6.2 Reviewer calibration (few-shot)

**Why**: 記事の核心。「Out of the box, Claude is a poor QA agent」→ few-shot 例 + スコア基準で calibration。

**設計:**
- `agent-reviewer.md` に few-shot 例を追加 (3例: critical, high, false-positive)
  - Good finding 例: 具体的な file:line + 再現手順 + Fix 提案
  - Bad finding 例: 曖昧な指摘、self-talk-out パターン
  - Filter 例: 「これは問題だが些細」→ 除外判断
- スコア基準の明示: Succinctness (1行), Accuracy (再現可能), Actionability (Fix が具体的)
- reviewer が自分の finding を approve してしまう self-talk-out パターンを明示的に禁止

### 6.3 Sprint contract (Verify ↔ Gate 紐付け)

**Why**: 記事の「実装前に evaluator と成功基準を交渉」。alfred の Verify フィールドは存在するが gate との連携がない。

**設計:**
- Plan テンプレートの Verify フィールドを拡張:
  - `Verify: bun vitest run src/__tests__/foo.test.ts` — 実行可能なコマンド形式を推奨
  - `Verify: biome check src/foo.ts — no errors` — gate 出力との照合形式
- ExitPlanMode 検証: Verify が空文字 or 汎用文言 ("テストが通る") → DENY
  - 具体的なファイル名 or コマンドを含むことを検証
- PostToolUse (Bash): テスト実行結果と Verify フィールドの自動照合を強化

### 6.4 状態リセットコマンド

**Why**: 壊れた状態からの回復手段がない。デバッグ不能。

**設計:**
- `alfred reset` — .alfred/.state/ 内の全 JSON を初期化
- `alfred reset --keep-history` — gate-history/metrics は保持、それ以外を初期化
- doctor に state 整合性チェック追加 (JSON parse 可能か、スキーマ妥当か)

### 6.5 advisory 棚卸し — 効果がない注入の削減

**Why**: 「壁 > 情報提示」を設計原則に掲げながら、14 hooks 中 9 が advisory。効果不明な注入はコンテキスト汚染。

**設計:**
- 6.1 metrics の結果を 2 週間収集
- advisory 注入後に Claude が実際に行動変更したケースを特定
- 効果が低い advisory を段階的に削除 or DENY に昇格
- 目標: advisory hooks を 9 → 5 以下に削減

### 6.6 Integration テスト追加

**Why**: 全テストがモック gate。実プロジェクトでの動作が未検証。

**設計:**
- `src/__tests__/integration/` ディレクトリ新設
- 実際の biome + tsc を使った gate 実行テスト (alfred 自身のコードで)
- Edit → gate fail → pending-fixes → 修正 → gate pass の E2E フロー
- CI で integration テストを分離実行 (遅いため)

---

## v1.0.0 — 知識復活 (必要になったら)

v0.x で十分な dogfooding データが溜まったら、必要に応じて復活。

### 1.1 error_resolution キャッシュ

**条件:** 「同じエラーに何度も遭遇し、毎回調べ直している」パターンが metrics で観測されたら。

SQLite (bun:sqlite) で軽量DB。PostToolUse で Bash エラー→成功ペアを保存。PostToolUseFailure でエラーを FTS5 検索→ヒットしたら注入。

### 1.2 fix_pattern キャッシュ

**条件:** 「同じ lint/type 修正パターンを毎回試行錯誤している」パターンが metrics で観測されたら。

gate fail → pass サイクルの before/after diff を保存。同じ gate 失敗時に過去の fix パターンを注入。

---

## 未定 (アイデアプール)

- **FileChanged hook** — gates.json 手動編集時の自動リロード
- **WorktreeCreate hook** — worktree 用 .alfred/ 初期化
- **Notification hook** — Slack/Discord 連携 (gate fail, Plan 未完了, Pace red)
- **prompt hook type でのレビュー** — Stop を agent hook にして LLM ベース品質検証
- **uninstall コマンド** — settings.json から hook 削除、全クリーンアップ
- **SDD ツール統合ガイド** — spec-kit / tsumiki との併用パターンのドキュメント化
