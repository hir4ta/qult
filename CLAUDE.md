# claude-alfred

Claude Code の暴走を止める執事。12 Hooks + Skill + Agent で品質の下限を守る。

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)

## アーキテクチャ

```
alfred CLI (init / hook / doctor)
    ├── alfred init → ~/.claude/ に 12 hooks, skill, agent, rules を配置
    └── alfred hook <event> → stdin JSON → 処理 → stdout JSON or exit 2
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
| PreToolUse | enforcement | DENY | pending-fixes, pace red, commit gates |
| PostToolUse | enforcement | respond | gate実行 → pending-fixes生成 |
| Stop | enforcement | block | pending-fixes, incomplete plan, no review (条件付き) |
| PermissionRequest | enforcement | DENY | ExitPlanMode plan構造検証 |
| ConfigChange | enforcement | DENY | hook削除防止 |
| SubagentStop | enforcement | block | reviewer PASS→gate clear / FAIL→block (修正+再レビュー要求) |
| SessionStart | advisory | respond | エラートレンド注入 |
| UserPromptSubmit | advisory | respond | Planテンプレート注入 (Plan mode のみ) |
| SubagentStart | advisory | respond | pending-fixes状態注入 |
| PostToolUseFailure | advisory | respond | /clear提案 |
| PreCompact | advisory | stderr | pending-fixes reminder |
| PostCompact | advisory | stderr | 構造化handoff (全クリティカル状態再注入) |

## 構造

```
src/
├── cli.ts                  # citty: init / hook / doctor / reset
├── init.ts                 # セットアップ (12 hooks + skill + agent + rules + gates)
├── doctor.ts               # ヘルスチェック (8項目 + --metrics) + state整合性検証
├── reset.ts                # 状態リセット (--keep-history で履歴保持)
├── hooks/
│   ├── dispatcher.ts       # event → handler ルーティング (12 events) + HOOK_CLASS分類
│   ├── respond.ts          # 共通: respond / deny / block + metrics記録
│   ├── post-tool.ts        # lint/type gate + pending-fixes + pace + batch + test-pass + verify
│   ├── pre-tool.ts         # pending-fixes → DENY + pace red → DENY + commit without test → DENY
│   ├── user-prompt.ts      # Plan テンプレート注入 (Plan mode のみ)
│   ├── permission-request.ts # ExitPlanMode: 適応型検証 (大Plan: 厳格, 小Plan: 軽量)
│   ├── session-start.ts    # .alfred作成 + gates自動検出 + エラートレンド注入
│   ├── stop.ts             # pending-fixes block + 大Plan未完了block + 小Plan warn + レビュー条件付き強制
│   ├── pre-compact.ts      # pending-fixes reminder (stderr)
│   ├── post-compact.ts     # 構造化handoff: 全クリティカル状態再注入 (stderr)
│   ├── subagent-start.ts   # pending-fixes状態注入 (Opus 4.6はrules自動継承)
│   ├── subagent-stop.ts    # reviewer PASS/FAIL + Score検証 + レビュー完了記録
│   ├── post-tool-failure.ts # ツール失敗追跡 + 2回連続→/clear
│   └── config-change.ts    # hook設定 変更 DENY (非hook設定は許可)
├── gates/
│   ├── runner.ts           # gate コマンド実行
│   ├── load.ts             # gates.json 読み込み
│   └── detect.ts           # プロジェクト設定 → gates.json 自動検出 (TS/Python/Go/Rust)
├── state/
│   ├── atomic-write.ts     # atomic JSON write (write-to-temp + rename)
│   ├── pending-fixes.ts    # 未修正 lint/type エラー
│   ├── session-state.ts    # 統合セッション状態 (pace, test, review, batch, fail, budget)
│   ├── gate-history.ts     # gate 結果トレンド + コミット間隔統計
│   ├── plan-status.ts      # Plan task status 解析
│   └── metrics.ts          # DENY/block/respond/gate-outcome/first-pass/review-outcome/review-miss 記録 (50件 cap)
├── templates/              # init が配置するファイル
│   ├── skill-review.md     # /alfred:review skill
│   ├── agent-reviewer.md   # reviewer agent (PASS/FAIL threshold)
│   └── rules-quality.md    # 品質ルール (適応型タスクスコープ)
└── types.ts
```

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
3. **少ない方が強い** — コンテキスト注入は最小限。指示は20行以内
4. **タスクスコープ適応** — 計画なし: 1-2ファイル集中。計画あり: 計画の境界に従う
5. **検証 > 指示** — 「何を検証すべきか」を伝える。HOW ではなく WHAT
6. **fail-open** — 全 hook は try-catch で握りつぶす。alfred の障害で Claude を止めない
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

### 状態ファイル (.alfred/.state/)
- pending-fixes.json — 未修正 lint/type エラー
- session-state.json — 統合セッション状態 (pace, test pass, review, gate batch, fail count, budget, action counters)
- gate-history.json — gate 結果トレンド + コミット間隔 (50件 cap)
- metrics.json — DENY/block/respond 発火記録 (50件 cap, `doctor --metrics` で表示)

### Sprint Contract (適応型)
- Anthropic記事 (2026-03-24) では Opus 4.6 で sprint construct を削除。alfredも適応:
  - **小Plan (≤3 tasks)**: 構造要件なし。Verify あれば具体的であること
  - **大Plan (4+ tasks)**: Success Criteria (具体的) + Verify フィールド (具体的) 必須
  - Review Gates: Plan構造では不要。review は stop.ts/pre-tool.ts で条件付き強制
- Success Criteria 質検証: 「tests pass」等の曖昧 criteria は DENY。行動レベルの具体的基準を要求
- UserPromptSubmit: Plan mode のみテンプレート注入 (非Plan advisory は Opus 4.6 で不要のため削除)
- Stop: 小Plan の未完了タスクは警告のみ (block ではない)
- reviewer は Opus モデルで実行 (Generator と同等能力での評価)。全 findings を報告 + Review: PASS/FAIL + Score (Correctness/Design/Security 1-5)。Judge (skill) のみが S/A/A フィルタを適用
- reviewer に few-shot 例 3つ + anti-self-persuasion 指示を配置
- Verify フィールド検証: テスト名の出力一致 + テストファイル内のアサーション存在確認

### レビュー閾値 (適応型)
- レビュー強制条件: Plan active **OR** changed_files >= 5
- 小変更 (Plan なし + 5ファイル未満): レビュー任意 (stderr warn のみ)
- 根拠: Anthropic記事 "the evaluator is not a fixed yes-or-no decision. It is worth the cost when the task sits beyond what the current model does reliably solo"
- スキップ時は `review:skipped` を metrics.json に記録

### 効果測定
- DENY 発火時に metrics.json へ記録。fix 後に resolution を記録
- gate 実行結果 (pass/fail) を metrics.json へ記録
- advisory skip (budget超過) を metrics.json へ記録
- First-pass clean rate: ファイル編集時に全 gate を初回で通過した率 (品質の直接指標)
- Review outcome: レビュー PASS/FAIL 率 + review:miss (PASS後のgate fail = evaluator見逃し) + review:skipped (閾値以下でスキップ)
- `doctor --metrics`: DENY resolution rate + gate pass rate + first-pass rate + review pass rate を表示
- `doctor --fix`: 壊れた state ファイルをデフォルト値にリセット

### Pace 制限 (適応型, Opus 4.6 対応)
- デフォルト: 120分 + 15ファイル = RED → DENY (Opus 4.6 の長時間coherent作業に対応)
- コミット3回以上: 平均間隔 × 2 (10-120分の範囲)
- Plan あり: threshold × 1.5 (180分 / 23ファイルまで許容)
- ConfigChange: hook設定のみ DENY。その他の user_settings 変更は許可
- **Hook matcher 最適化**: PreToolUse/PostToolUse は Edit/Write/Bash のみ、PostToolUseFailure は Bash のみに matcher 設定。Read/Glob/Grep 等でプロセス起動しない

### Phase Gate (各コミット前に必ず実行)
1. `bun vitest run` — 全テスト pass
2. `bun vitest run src/__tests__/simulation.test.ts` — シミュレーション pass
3. `bun tsc --noEmit && bun biome check src/` — 型 + lint clean
4. `/alfred:review` — 独立レビュー (自己評価は機能しない。必ずサブエージェントで実行)
5. コミット — Phase Gate 通過後にのみコミット

### シミュレーション
- Hook や状態管理の変更後は simulation.test.ts にシナリオを追加する
- シミュレーションは本番フロー (Edit→gate→pending-fixes→DENY) を再現する統合テスト

## 評価・分析の誠実性

- 主張には裏付けの強さを明示: **事実** (一次ソース引用可能) / **推測** (根拠はあるが直接証拠なし) / **意見** (自分の解釈)
- 一次ソースを確認せずに「記事によると」「研究では」と断言しない
- 裏付けが取れていない主張を、取れているかのように提示しない。未検証なら「未検証」と明記
- 自己検証を後回しにしない。主張する前にソースを確認する

## 設計ドキュメント

- research-harness-engineering-2026.md — リサーチ結果
- research-claude-code-plugins-2026.md — Plugin 調査結果
