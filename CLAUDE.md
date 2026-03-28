# qult

Claude Code の品質を構造で守る evaluator harness。12 Hooks + Skill + Agent で品質の下限を機械的に担保。

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)

## アーキテクチャ

```
qult CLI (init / hook / doctor)
    ├── qult init → ~/.claude/ に 12 hooks, skill, agent, rules を配置
    └── qult hook <event> → stdin JSON → 処理 → stdout JSON or exit 2
```

3つの柱 + 2つの防御層:
1. **壁** — PostToolUse (gate) → PreToolUse (DENY)
2. **Plan増幅** — UserPromptSubmit (template) + PermissionRequest (ExitPlanMode)
3. **実行ループ** — Stop (Plan未完了block + pending-fixes block) + PreCompact (reminder) + PostCompact (構造化handoff)
4. **サブエージェント制御** — SubagentStart (pending-fixes状態注入) + SubagentStop (pass/fail threshold)
5. **自己防御** — ConfigChange (hook削除防止) + PostToolUseFailure (失敗追跡)

## Hook 分類

| Hook | 分類 | 出力 | 説明 |
|------|------|------|------|
| PreToolUse | enforcement | DENY | pending-fixes, pace red, LOC limit, commit gates |
| PostToolUse | enforcement | respond | gate実行 → pending-fixes生成 |
| Stop | enforcement | block | pending-fixes, incomplete plan, no review, unverified fields, unexecuted criteria (条件付き) |
| PermissionRequest | enforcement | DENY | ExitPlanMode plan構造検証 |
| ConfigChange | enforcement | DENY | hook削除防止 |
| SubagentStop | enforcement | block | reviewer PASS→gate clear / FAIL→block (修正+再レビュー要求) |
| SessionStart | advisory | respond | エラートレンド注入 + 自動キャリブレーション + 外部コンテキスト |
| UserPromptSubmit | advisory | respond | Planテンプレート注入 (Plan mode のみ) |
| SubagentStart | advisory | respond | pending-fixes状態注入 |
| PostToolUseFailure | advisory | respond | /clear提案 |
| PreCompact | advisory | stderr | pending-fixes reminder |
| PostCompact | advisory | stderr | 構造化handoff (全クリティカル状態再注入) |

## コマンド

```bash
task build    # bun build (バンドル)
task check    # tsc --noEmit + Biome lint
task fix      # Biome 自動修正
task test     # vitest run
task clean    # ビルド成果物削除
```

`bun tsc` / `bun vitest` を使う（`npx` 不要）

## 設計原則

1. **リサーチ駆動** — 効果が実証された手法のみ実装 (research-harness-engineering-2026.md)
2. **壁 > 情報提示** — DENY (exit 2) > additionalContext
3. **少ない方が強い** — コンテキスト注入は最小限。Hook注入は20行以内
4. **タスクスコープ適応** — 計画なし: 1-2ファイル集中。計画あり: 計画の境界に従う
5. **検証 > 指示** — 「何を検証すべきか」を伝える。HOW ではなく WHAT
6. **fail-open** — 全 hook は try-catch で握りつぶす。qult の障害で Claude を止めない
7. **simplest solution** — 全コンポーネントは load-bearing 仮定を持つ。仮定が崩れたら削除

## ルール

### ビルド
- `bun build.ts` → `dist/cli.mjs`
- `bun build.ts --compile` → シングルバイナリ
- **dependencies ゼロ** — 全て devDependencies + bun build バンドル

### Hook 設計
- 全 hook は fail-open (try-catch で握りつぶす)
- exit 2 = DENY/block (唯一の強制手段)。stderr にも理由を出力
- additionalContext = advisory (Claude は無視可能)
- PostToolUse 検出 → PreToolUse ブロックの二段構え
- SubagentStart でpending-fixes状態をサブエージェントに伝搬 (品質ルールはOpus 4.6が自動継承)
- PostCompact で構造化handoff: compaction後に全クリティカル状態を再注入
- 全state file書き込みは atomic write (write-to-temp + rename) で race condition を防止
- **Hook 出力スキーマ対応表** (https://code.claude.com/docs/en/hooks 準拠):
  - respond() (hookSpecificOutput.additionalContext): SessionStart, PostToolUse, PostToolUseFailure, SubagentStart
  - deny() (hookSpecificOutput.permissionDecision): PreToolUse, PermissionRequest
  - block() (トップレベル decision/reason): Stop, UserPromptSubmit, SubagentStop
  - 出力なし (stderr で advisory): PostCompact, PreCompact, ConfigChange

### Gates
- on_write: 編集時に実行 (lint, typecheck)
- on_commit: コミット時に実行 (test)
- on_review: レビュー時に reviewer が実行 (e2e — playwright/cypress 自動検出)

### 状態ファイル
- `.qult/.state/pending-fixes.json` — 未修正 lint/type エラー
- `.qult/.state/session-state.json` — 統合セッション状態 (pace, test pass, review, gate batch, fail count, budget, action counters, verified_fields, criteria_commands_run, changed_lines)
- `.qult/.state/calibration.json` — 自動キャリブレーション結果 (pace_files, review_file_threshold, context_budget, loc_limit)
- `.qult/metrics/YYYY-MM/YYYY-MM-DD.json` — DENY/block/respond 発火記録 (日次ローテーション, 上限なし)
- `.qult/gate-history/YYYY-MM/YYYY-MM-DD.json` — gate 結果 + コミット履歴 (日次ローテーション, 上限なし)
- `.qult/context-providers.json` — 外部コンテキストプロバイダー設定 (CI/CD状態等)
- 各エントリに session_id, project_id, branch, user を記録 (チーム開発 + TUI 対応)

### Sprint Contract (適応型)
- Opus 4.6 で sprint construct を削除。qultも適応:
  - **小Plan (≤3 tasks)**: 構造要件なし。Verify あれば具体的であること
  - **大Plan (4+ tasks)**: Success Criteria (具体的) + Verify フィールド (具体的) 必須
  - Review Gates: Plan構造では不要。review は stop.ts/pre-tool.ts で条件付き強制
- Success Criteria 質検証: 「tests pass」等の曖昧 criteria は DENY。行動レベルの具体的基準を要求
- UserPromptSubmit: Plan mode のみテンプレート注入 (WHAT/WHERE/VERIFY/BOUNDARY/SIZE)
- Stop: 小Plan の未完了タスクは警告のみ (block ではない)
- reviewer は Opus モデルで実行 (Generator と同等能力での評価)。全 findings を報告 + Review: PASS/FAIL + Score (Correctness/Design/Security 1-5)。Judge (skill) のみが S/A/A フィルタを適用
- reviewer に few-shot 例 3つ + anti-self-persuasion 指示を配置
- reviewer findings: severity 別カウント (critical/high/medium/low) を metrics に記録。`doctor --metrics` で precision 表示
- **Plan Contract Enforcement** (大Plan block / 小Plan warn):
  - Verify 実行完了: 全 Verify field のテスト関数が実行・pass したか stop 時に検証
  - File field 必須 (大Plan): 各タスクに変更対象ファイルを明示
  - Criteria 実行完了: Success Criteria の backtick コマンドが実際に実行されたか検証
  - File divergence: Plan 外のファイル変更が Plan 内を超過したら scope creep 警告 (advisory)

### レビュー閾値 (適応型)
- レビュー強制条件: Plan active **OR** gated_files >= 5
- gated_files: on_write gate がカバーする拡張子のファイルのみカウント (.md等は除外)
- 小変更 (Plan なし + gated 5ファイル未満): レビュー任意 (stderr warn のみ)
- スキップ時は `review:skipped` を metrics に記録

### 効果測定
- 全メトリクスは日次ローテーションファイルに記録 (`.qult/metrics/`, `.qult/gate-history/`)
- 各エントリに session_id, project_id, branch, user を自動付与
- DENY: defensive (config-change) vs actionable (lint/typecheck等) に分類。resolution rate は actionable のみ
- Gate: 実行結果 (pass/fail) + 実行時間 (duration_ms) + gate 名別 pass rate
- Fix effort: DENY→resolution 間の編集回数を追跡
- First-pass clean rate: ファイル編集時に全 gate を初回で通過した率 + gate 別内訳
- Review: PASS/FAIL 率 + findings (severity別) + review:miss (PASS後のgate fail)
- Plans: permission-request の approve/deny 率
- Commits: 間隔統計 (avg/median/min/max) + DENYs per commit
- `doctor --metrics`: Actions / Top reasons (種別別) / Effectiveness / Gates / Review / Commits / Plans / Calibration セクション表示
- `doctor --fix`: 壊れた state ファイルをデフォルト値にリセット

### LOC 制限
- PostToolUse で Edit/Write の変更行数を計測 (old_string/new_string の行数差分)
- session-state.changed_lines に累積記録。コミット時にリセット
- PreToolUse で LOC 制限チェック: デフォルト 200行 (Plan あり 300行)
- キャリブレーション値があればそちらを使用

### 自動キャリブレーション
- SessionStart で24時間ごとに metrics から閾値を自動調整
- 調整対象: pace_files, review_file_threshold, context_budget, loc_limit
- ルール: first-pass rate → pace_files, review:miss → review threshold, respond-skipped率 → budget, fix effort → loc_limit
- `.qult/.state/calibration.json` に保存。`doctor --metrics` で確認可能

### 外部コンテキストプロバイダー
- `.qult/context-providers.json` でコマンドベースの外部コンテキスト取得を宣言
- SessionStart で inject_on: "session_start" のプロバイダーを実行し結果を注入
- fail-open: 個々のプロバイダー失敗は無視
- `/qult:detect-gates` で `gh` CLI 存在時に ci_status プロバイダーを自動生成

### Pace 制限 (適応型, Opus 4.6 対応)
- デフォルト: 120分 + 15ファイル = RED → DENY (Opus 4.6 の長時間coherent作業に対応)
- LOC 制限: 200行 (Plan あり 300行) → DENY。キャリブレーションで自動調整
- コミット3回以上: 平均間隔 × 2 (10-120分の範囲)
- Plan あり: threshold × 1.5 (180分 / 23ファイルまで許容)
- ConfigChange: hook設定のみ DENY。その他の user_settings 変更は許可
- **Hook matcher 最適化**: PreToolUse/PostToolUse は Edit/Write/Bash のみ、PostToolUseFailure は Bash のみに matcher 設定。Read/Glob/Grep 等でプロセス起動しない

### Phase Gate (各コミット前に必ず実行)
1. `bun vitest run` — 全テスト pass
2. `bun vitest run src/__tests__/simulation.test.ts` — シミュレーション pass
3. `bun tsc --noEmit && bun biome check src/` — 型 + lint clean
4. `/qult:review` — 独立レビュー (自己評価は機能しない。必ずサブエージェントで実行)
5. コミット — Phase Gate 通過後にのみコミット

### シミュレーション
- Hook や状態管理の変更後は simulation.test.ts にシナリオを追加する
- シミュレーションは本番フロー (Edit→gate→pending-fixes→DENY) を再現する統合テスト

## 設計ドキュメント

@docs/research-harness-engineering-2026.md
@docs/research-claude-code-plugins-2026.md
