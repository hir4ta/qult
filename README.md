# qult

Claude Code の品質を構造で守る **evaluator harness**。quality + cult = qult。

> Claude は優秀だが、lint エラーを放置して次のファイルに行く。テストなしでコミットする。自分のコードを褒めてレビューを終える。
> qult はそれを **物理的に止める**。お願い (advisory) ではなく、exit 2 (DENY) で。

## なぜ evaluator harness か

Anthropic の [Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps) 記事が示した核心

- **自己評価は機能しない** — Claude は自分の仕事の問題を見つけても「大したことない」と自分を説得する
- **独立 evaluator が必須** — generator と evaluator を分離することで品質が跳ねる
- **全コンポーネントは仮定** — 「モデルが単独でできないこと」を encode し、陳腐化したら捨てる
- **simplest solution possible** — 必要な時だけ複雑性を追加。不要なものは削除

qult は Claude Code の 12 hooks として動作し、**Opus evaluator で**、Claude の行動を機械的にゲートする。TypeScript, Python, Go, Rust を自動検出。世の SDD ツールの大半は「お願い」。qult は「壁」。

## 何を防ぐか

```
Edit → biome check 失敗 → pending-fixes 記録
  → 別ファイルを Edit しようとする → DENY (exit 2)
  → 同じファイルを修正 → biome check 通過 → 解除
```

| 状況 | qult の行動 |
|---|---|
| lint/type エラーを放置して別ファイルへ | **DENY** — 修正するまでブロック |
| テスト未実行で git commit | **DENY** — テスト pass を要求 |
| レビュー未実行で完了宣言 (大変更) | **block** — /qult:review を要求 (Plan active or 5+ファイル変更時。小変更は任意) |
| レビュー FAIL で完了宣言 | **block** — 修正して再レビューを要求 |
| レビュー PASS だがスコア低い (aggregate < 12/15) | **block** — 弱い次元を修正して再レビュー (最大3回反復) |
| 大Plan (4+ tasks) で plan evaluation 未実施 | **DENY** — /qult:plan-review を要求 |
| Plan (4+ tasks) に曖昧な Success Criteria | **DENY** — 「tests pass」ではなく行動レベルの基準を要求 |
| Plan (4+ tasks) に具体的な Verify がない | **DENY** — テスト名/コマンドを要求 |
| Plan (4+ tasks) に File field がない | **DENY** — 変更対象ファイルの明示を要求 |
| Plan の Verify field テストが未実行 | **block** — テスト実行を要求 (大Plan block / 小Plan warn) |
| Plan の Success Criteria コマンドが未実行 | **block** — コマンド実行を要求 (大Plan block / 小Plan warn) |
| Plan 外のファイルを大量に変更 | **warn** — scope creep 警告 (advisory) |
| 200行以上の変更 (コミット間) | **DENY** — LOC 制限超過。コミットを要求 (Plan ありは 300行。キャリブレーションで自動調整) |
| 120分以上コミットなし + 15ファイル変更 | **DENY** — スコープ肥大を阻止 (Plan ありは 180分/23ファイルまで猶予) |
| hook 設定を変更しようとする | **DENY** — 自己防衛 (非 hook 設定は許可) |

## 12 Hooks (6 enforcement + 6 advisory)

**壁 (enforcement)** — 壊れたコードを通さない
- **PostToolUse** `[Edit/Write/Bash]`: 編集後に gate 実行。失敗 → pending-fixes + first-pass/gate outcome 記録
- **PreToolUse** `[Edit/Write/Bash]`: pending-fixes → DENY。Pace red → DENY。LOC 制限超過 → DENY。commit without test → DENY。review は条件付き (Plan or 5+ファイル)

**Plan 増幅 (enforcement)** — 設計の質を底上げ
- **UserPromptSubmit**: Plan mode 時のみテンプレート注入 (WHAT/WHERE/VERIFY/BOUNDARY/SIZE)
- **PermissionRequest** `[ExitPlanMode]`: Plan 構造検証 + 大Plan は独立 plan evaluation 必須

**実行ループ (enforcement + advisory)** — 中途半端に終わらせない
- **Stop**: 未修正エラー/大Plan未完了/verify未実行/criteria未実行 → block。file divergence → warn。レビュー未実行 → 条件付き block
- **PostCompact**: **構造化handoff** — 全クリティカル状態 (pending-fixes, Plan進捗, gate clearance, pace, review iteration, plan evaluation, error trends) を再注入
- **PreCompact**: pending-fixes reminder (stderr)
- **SessionStart**: 自動セットアップ + エラートレンド注入 + 自動キャリブレーション + 外部コンテキスト注入

**サブエージェント制御 (enforcement + advisory)** — 品質ルールを伝搬
- **SubagentStart**: pending-fixes 状態注入 (品質ルールは Opus 4.6 が CLAUDE.md/rules から自動継承)
- **SubagentStop**: reviewer スコア閾値強制 (PASS でも aggregate < 12/15 → block + 反復) + plan-evaluator 検証

**自己防衛 (enforcement + advisory)** — harness 自体を守る
- **PostToolUseFailure** `[Bash]`: 2回連続失敗 → /clear 提案
- **ConfigChange**: hook 設定変更 → DENY

## 設計原則

1. **壁 > 情報提示** — DENY (exit 2) で止める。additionalContext は無視される前提
2. **リサーチ駆動** — 全設計判断に SWE-bench / Anthropic 記事 / Self-Refine 論文の裏付け
3. **fail-open** — 全 hook は try-catch。qult の障害で Claude を止めない
4. **Opus 4.6 適応** — Pace 120分、非Plan advisory 削除、sprint 構造緩和
5. **simplest solution** — 全コンポーネントは load-bearing 仮定を持つ。仮定が崩れたら捨てる
6. **効果測定** — first-pass clean rate + advisory compliance + review scores + clean commit rate で品質を多層計測
7. **dependencies ゼロ** — 全て devDependencies + bun build バンドル

## 効果測定

```bash
qult doctor --metrics
```

実行すると以下のようなレポートが表示される:

```
--- Metrics (293 actions across 5 sessions) ---

  Actions:
    DENY:            105  (43 actionable, 62 defensive)
    block:           5
    respond:         32
    respond-skipped: 2  (budget exceeded)
    review:miss:     1

  Top DENY reasons (actionable):    ...
  Top block reasons:                ...
  Top gate failures:                ...

  Effectiveness:
    DENY resolution (actionable): 16/43 (37%)
    Avg fix effort: 2.3 edits/resolution
    Gate pass rate: 67%
    First-pass clean: 80% (recent: 75%)
    DENYs per commit: 4.3
    Peak consecutive errors: 3

  Gates:
    lint         pass 63%, avg 74ms
    typecheck    pass 100%, avg 626ms

  First-pass by gate:
    lint         72% (8 failures)

  Review:
    Pass rate: 100% (3 reviews)
    Findings: 9 total (avg 3/review)
    Severity: 0 crit, 0 high, 4 med, 5 low
    Misses: 1

  Commits:
    10 commits, avg 22m, med 6m, range 0-127m

  Plans:
    Approved: 4, Rejected: 1 (80% pass)

  Plan compliance:
    Avg score: 82/100 (4 plans)
    Weakest: boundary=3, change=5

  Advisory compliance:
    Overall: 85% (20 tracked)
    fix            90% (10)
    error-loop     70% (5)
    verify-check   80% (5)

  Artifact quality:
    Clean commit rate: 70% (7/10 commits)
    Avg review scores: Correctness=4.2 Design=3.8 Security=4.6
    Hotspot files (high fail rate):
      src/hooks/post-tool.ts                   fail 40% (8 runs)
```

### ヘッダー

| 項目 | 意味 |
|------|------|
| **actions** | hook が発火して記録された個々のアクション数 (1回のファイル編集で lint + typecheck = 2 actions) |
| **sessions** | `session_id` が記録された Claude Code セッションの数。セッション追跡は v0.11 以降のデータのみ |

### Actions セクション

| 項目 | 意味 |
|------|------|
| **DENY** | Claude の操作を強制ブロックした回数。**actionable** = lint/typecheck 失敗等の修正すべきブロック。**defensive** = hook 設定保護 (正常動作) |
| **block** | Claude が「完了」しようとした時に止めた回数 (未修正エラー、レビュー未実行等) |
| **respond** | Claude のコンテキストに情報を注入した回数 (Plan テンプレート、エラートレンド等) |
| **respond-skipped** | コンテキストバジェット超過でスキップされた注入回数。自動キャリブレーションで調整される |
| **review:miss** | レビュー PASS 後に gate が失敗した回数。evaluator が問題を見逃したことを示す (calibration 指標) |

### Top reasons セクション

種別ごとに最頻出の理由を表示:

| セクション | 何が見える |
|------|------|
| **Top DENY reasons (actionable)** | 最も頻繁にブロックされた理由。`pending-fixes` が多ければ lint 品質、`pace red` が多ければスコープ管理に課題 |
| **Top block reasons** | 完了ブロックの理由。`Pending lint/type errors` が多ければ修正せずに完了しようとしている |
| **Top gate failures** | lint rule / TypeScript error コード別の失敗パターン。例: `lint/correctness/noUnusedImports` が頻出なら import 管理に課題 |

### Effectiveness セクション

qult の効果を測る中核指標:

| 指標 | 意味 | 目安 |
|------|------|------|
| **DENY resolution (actionable)** | DENY 後に Claude が修正に成功した率。0% なら resolution 追跡が未機能の可能性 | 高いほど良い |
| **Avg fix effort** | 1つの DENY を解消するのに要した編集回数 | 低いほど良い (1-2 が理想) |
| **Gate pass rate** | 全 gate 実行のうち通過した割合 | 70%+ が目安 |
| **First-pass clean** | ファイル初回編集時に全 gate を通過した率。**(recent: N%)** は直近20件の推移 | 高いほど品質が高い |
| **DENYs per commit** | 1コミットに辿り着くまでの actionable DENY 回数。ハーネスの「摩擦コスト」 | 低いほどスムーズ |
| **Peak consecutive errors** | セッション中の最大連続エラー数。Claude がスタックした度合い | 3+ なら /clear を検討 |

### Gates セクション

gate 名ごとの通過率と平均実行時間:

| 項目 | 意味 |
|------|------|
| **pass N%** | その gate の通過率 |
| **avg Nms** | 平均実行時間。遅い gate は timeout 調整の参考に |

### First-pass by gate セクション

gate 別の「初回編集で失敗した率」。全体の first-pass rate が低い時、どの gate が原因かを特定できる。

### Review セクション

| 指標 | 意味 |
|------|------|
| **Pass rate** | Opus evaluator のレビュー PASS 率 |
| **Findings** | レビュー指摘の総件数と平均 |
| **Severity** | critical / high / medium / low の内訳 |
| **Misses** | レビュー PASS 後に gate 失敗が発生した回数 (evaluator の見逃し) |

### Commits セクション

| 項目 | 意味 |
|------|------|
| **N commits** | 記録されたコミット数 |
| **avg / med / range** | コミット間隔の平均・中央値・最小-最大 (分)。pace 閾値の妥当性確認に使う |

### Plans セクション

| 項目 | 意味 |
|------|------|
| **Approved** | ExitPlanMode で Plan 構造検証を通過した回数 |
| **Rejected** | Plan 構造不備で差し戻された回数 |
| **N% pass** | Plan の承認率。低い場合は Plan テンプレートの改善を検討 |

### Plan compliance セクション

Plan テンプレート (WHAT/WHERE/VERIFY/BOUNDARY) への遵守率を 0-100 でスコアリング:

| 項目 | 意味 |
|------|------|
| **Avg score** | 全 Plan の平均遵守スコア (100 = 完全準拠) |
| **Weakest** | 最も低いフィールドカバレッジ。改善すべきテンプレート要素を示す |

### Advisory compliance セクション

respond() で注入したアドバイスに Claude が従ったかを追跡:

| 項目 | 意味 |
|------|------|
| **fix** | gate 失敗時の修正アドバイス → 次の編集が指定ファイルか |
| **error-loop** | 2回連続エラー後の /clear 提案 → 異なるアプローチを試みたか |
| **verify-check** | Plan verify チェック失敗 → 修正を試みたか |

### Artifact quality セクション

プロセス品質ではなく成果物の品質を測定:

| 指標 | 意味 |
|------|------|
| **Clean commit rate** | セッション内で DENY ゼロでコミットできた割合 |
| **Avg review scores** | Opus evaluator の Correctness/Design/Security スコア平均 (1-5) |
| **Hotspot files** | gate 失敗率の高いファイル。品質リスクの集中箇所 |

### Calibration セクション

qult は24時間ごとに metrics から閾値を自動調整する。線形補間 (lerp) で滑らかに調整:

| 閾値 | デフォルト | 範囲 | 調整基準 |
|------|-----------|------|----------|
| **pace_files** | 15 | 10-25 | first-pass rate (40-90%) で補間 |
| **review_file_threshold** | 5 | 3-7 | review-miss rate (0-10%) で補間 |
| **context_budget** | 2000 | 1500-2500 | respond-skipped rate (0-30%) で補間 |
| **loc_limit** | 200 | 150-250 | avg fix effort (1-4 edits) で補間 |
| **plan_task_threshold** | 3 | 2-5 | plan compliance score (50-90) で補間 |
| **review_score_threshold** | 12 | 12-14 | review-miss rate (0-15%) で補間 |

**コールドスタート**: メトリクス不足 (firstPassTotal < 10) 時は `gates.json` の gate 数からヒューリスティック初期値を設定 (4+ gates → 厳格デフォルト)

## 外部コンテキストプロバイダー

`.qult/context-providers.json` でセッション開始時に外部情報を取り込む:

```json
{
  "ci_status": {
    "command": "gh run list --limit 3 --json status,conclusion,name --jq '...'",
    "timeout": 5000,
    "inject_on": "session_start"
  }
}
```

`/qult:detect-gates` で `gh` CLI 存在時に自動生成される。

## インストール

```bash
bun install
bun build.ts
bun link

qult init       # ~/.claude/ に 12 hooks + skill + agent + rules を配置
qult doctor     # セットアップの健全性を確認
```

## Gate 自動検出

`/qult:detect-gates` で自動検出、`.qult/gates.json` に書き込み:

| 言語 | on_write (lint/type) | on_commit (test) | on_review (e2e) |
|---|---|---|---|
| **TypeScript/JS** | `biome check {file}` / `eslint {file}` / `tsc --noEmit` | `vitest run` / `jest` / `mocha` | — |
| **Python** | `ruff check {file}` / `pyright` / `mypy` | `pytest` | — |
| **Go** | `go vet ./...` | `go test ./...` | — |
| **Rust** | `cargo clippy` / `cargo check` | `cargo test` | — |
| **Ruby** | `rubocop {file}` | `rspec` | — |
| **Java/Kotlin** | `ktlint` / `detekt` | `gradle test` / `mvn test` | — |
| **Elixir** | `credo` | `mix test` | — |
| **Deno** | `deno lint {file}` | `deno test` | — |
| **Frontend** | `stylelint {file}` | — | `playwright test` / `cypress run` / `wdio` |

## データストレージ

メトリクスと gate 実行履歴は日次ローテーションで永続化:

```
.qult/
├── metrics/            # hook アクション記録
│   └── 2026-03/
│       ├── 2026-03-27.json
│       └── 2026-03-28.json
├── gate-history/       # gate 実行結果 + コミット履歴
│   └── 2026-03/
│       └── 2026-03-28.json
├── context-providers.json  # 外部コンテキスト設定
└── .state/             # セッション状態 (非ローテーション)
    ├── session-state-{sessionId}.json  # セッション別
    ├── pending-fixes-{sessionId}.json  # セッション別
    └── calibration.json    # 自動キャリブレーション結果 (共有)
```

- 1日1ファイル、エントリ上限なし
- `qult doctor --metrics` は全日分を集計して表示
- 旧フォーマット (`.state/metrics.json`) は `qult init` または次回セッション開始時に自動マイグレーション
- **セッション分離**: session-state と pending-fixes はセッション ID でスコープ。並行セッション間の干渉を防止。24h 経過した古いファイルは session-start で自動クリーンアップ

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)
