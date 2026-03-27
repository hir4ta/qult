# alfred

Claude Code の暴走を止める執事。品質の下限を機械的に守る **evaluator harness**。

> Claude は優秀だが、lint エラーを放置して次のファイルに行く。テストなしでコミットする。自分のコードを褒めてレビューを終える。
> alfred はそれを **物理的に止める**。お願い (advisory) ではなく、exit 2 (DENY) で。

## なぜ evaluator harness か

Anthropic の [Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps) 記事が示した核心:

- **自己評価は機能しない** — Claude は自分の仕事の問題を見つけても「大したことない」と自分を説得する
- **独立 evaluator が必須** — generator と evaluator を分離することで品質が跳ねる
- **全コンポーネントは仮定** — 「モデルが単独でできないこと」を encode し、陳腐化したら捨てる
- **simplest solution possible** — 必要な時だけ複雑性を追加。不要なものは削除

alfred は Claude Code の 12 hooks として動作し、**Opus evaluator で**、Claude の行動を機械的にゲートする。TypeScript, Python, Go, Rust を自動検出。世の SDD ツールの大半は「お願い」。alfred は「壁」。

## 何を防ぐか

```
Edit → biome check 失敗 → pending-fixes 記録
  → 別ファイルを Edit しようとする → DENY (exit 2)
  → 同じファイルを修正 → biome check 通過 → 解除
```

| 状況 | alfred の行動 |
|---|---|
| lint/type エラーを放置して別ファイルへ | **DENY** — 修正するまでブロック |
| テスト未実行で git commit | **DENY** — テスト pass を要求 |
| レビュー未実行で完了宣言 (大変更) | **block** — /alfred:review を要求 (Plan active or 5+ファイル変更時。小変更は任意) |
| レビュー FAIL で完了宣言 | **block** — 修正して再レビューを要求 |
| Plan (4+ tasks) に曖昧な Success Criteria | **DENY** — 「tests pass」ではなく行動レベルの基準を要求 |
| Plan (4+ tasks) に具体的な Verify がない | **DENY** — テスト名/コマンドを要求 |
| 120分以上コミットなし + 15ファイル変更 | **DENY** — スコープ肥大を阻止 (Plan ありは 180分/23ファイルまで猶予) |
| hook 設定を変更しようとする | **DENY** — 自己防衛 (非 hook 設定は許可) |

## 12 Hooks (6 enforcement + 6 advisory)

**壁 (enforcement)** — 壊れたコードを通さない
- **PostToolUse** `[Edit/Write/Bash]`: 編集後に gate 実行。失敗 → pending-fixes + first-pass/gate outcome 記録
- **PreToolUse** `[Edit/Write/Bash]`: pending-fixes → DENY。Pace red → DENY。commit without test → DENY。review は条件付き (Plan or 5+ファイル)

**Plan 増幅 (enforcement)** — 設計の質を底上げ
- **UserPromptSubmit**: Plan mode 時のみテンプレート注入 (非Plan advisory は Opus 4.6 で不要のため削除)
- **PermissionRequest** `[ExitPlanMode]`: Plan 構造検証 + Success Criteria 質検証 (曖昧 criteria DENY)

**実行ループ (enforcement + advisory)** — 中途半端に終わらせない
- **Stop**: 未修正エラー/大Plan未完了 → block。レビュー未実行 → 条件付き block (Plan or 5+ファイル)
- **PostCompact**: **構造化handoff** — 全クリティカル状態 (pending-fixes, Plan進捗, gate clearance, pace, error trends) を再注入
- **PreCompact**: pending-fixes reminder (stderr)
- **SessionStart**: 自動セットアップ + エラートレンド注入

**サブエージェント制御 (enforcement + advisory)** — 品質ルールを伝搬
- **SubagentStart**: pending-fixes 状態注入 (品質ルールは Opus 4.6 が CLAUDE.md/rules から自動継承)
- **SubagentStop**: reviewer PASS → review gate クリア / FAIL → block (修正+再レビュー要求)

**自己防衛 (enforcement + advisory)** — harness 自体を守る
- **PostToolUseFailure** `[Bash]`: 2回連続失敗 → /clear 提案
- **ConfigChange**: hook 設定変更 → DENY

## 設計原則

1. **壁 > 情報提示** — DENY (exit 2) で止める。additionalContext は無視される前提
2. **リサーチ駆動** — 全設計判断に SWE-bench / Anthropic 記事 / Self-Refine 論文の裏付け
3. **fail-open** — 全 hook は try-catch。alfred の障害で Claude を止めない
4. **Opus 4.6 適応** — Pace 120分、非Plan advisory 削除、sprint 構造緩和
5. **simplest solution** — 全コンポーネントは load-bearing 仮定を持つ。仮定が崩れたら捨てる
6. **効果測定** — first-pass clean rate + review pass/miss rate + gate pass rate で品質を計測
7. **dependencies ゼロ** — 全て devDependencies + bun build バンドル

## 効果測定

```bash
alfred doctor --metrics
```

| 指標 | 意味 |
|------|------|
| First-pass clean rate | ファイル編集時に全 gate を初回で通過した率 (品質の直接指標) |
| Review pass rate | Opus evaluator のレビュー PASS 率 |
| Review misses | レビュー PASS 後にゲート失敗が発生した回数 (evaluator calibration 指標) |
| DENY resolution rate | DENY 発火後に修正された率 |
| Gate pass rate | gate 実行の通過率 |

## インストール

```bash
bun install
bun build.ts
bun link

alfred init       # ~/.claude/ に 12 hooks + skill + agent + rules を配置
alfred doctor     # セットアップの健全性を確認
```

## Gate 自動検出

`alfred init` がプロジェクトの設定ファイルから gate を自動検出:

| 言語 | on_write (lint/type) | on_commit (test) | on_review (e2e) |
|---|---|---|---|
| **TypeScript** | `biome check` / `eslint` / `tsc --noEmit` | `vitest --changed` / `jest` | — |
| **Python** | `ruff check` / `pyright` / `mypy` | `pytest` | — |
| **Go** | `go vet` | `go test` | — |
| **Rust** | `cargo clippy` | `cargo test` | — |
| **Frontend** | — | — | `playwright test` / `cypress run` |

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)
