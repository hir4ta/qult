# claude-alfred

Claude Code の性能を倍増させる執事。Hooks + Skills + Agents のみ。

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)

## アーキテクチャ

```
alfred CLI (init / hook / doctor)
    ├── alfred init → ~/.claude/ に hooks, skills, agents, rules を配置
    └── alfred hook <event> → stdin JSON → 処理 → stdout JSON or exit 2
```

3つの柱:
1. **壁** — PostToolUse (lint/type gate) → PreToolUse (DENY)
2. **Plan増幅** — UserPromptSubmit (テンプレート注入) + PermissionRequest (ExitPlanMode検証)
3. **実行ループ** — Stop (レビュー強制 + pace) + PreCompact (構造化ハンドオフ)

## 構造

```
src/
├── cli.ts              # citty: init / hook / doctor
├── init.ts             # セットアップ
├── doctor.ts           # ヘルスチェック
├── hooks/
│   ├── dispatcher.ts   # event → handler ルーティング
│   ├── post-tool.ts    # lint/type gate + pending-fixes 書込
│   ├── pre-tool.ts     # pending-fixes → DENY + pace
│   ├── user-prompt.ts  # Plan テンプレート注入
│   ├── session-start.ts # プロファイル + ハンドオフ復元
│   ├── stop.ts         # レビュー強制 + pace
│   └── pre-compact.ts  # 構造化ハンドオフ保存
├── gates/
│   ├── runner.ts       # gate コマンド実行
│   └── detect.ts       # package.json → gates.json 自動検出
├── state/
│   ├── pending-fixes.ts
│   ├── pace.ts
│   └── handoff.ts
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
4. **タスクサイズ制御** — 15 LOC以下・単一ファイル (SWE-bench: 80%+ 成功率)
5. **検証 > 指示** — 「何を検証すべきか」を伝える。HOW ではなく WHAT

## ルール

### ビルド
- `bun build.ts` → `dist/cli.mjs`
- `bun build.ts --compile` → シングルバイナリ
- **dependencies ゼロ** — 全て devDependencies + bun build バンドル

### Hook 設計
- 全 hook は fail-open (try-catch で握りつぶす)
- exit 2 = DENY (唯一の強制手段)
- additionalContext = advisory (Claude は無視可能)
- PostToolUse 検出 → PreToolUse ブロックの二段構え

### 状態ファイル (.alfred/.state/)
- pending-fixes.json — 未修正 lint/type エラー
- session-pace.json — Pace 追跡
- handoff.json — 構造化ハンドオフ
- project-profile.json — 言語/テストFW/リンター

### シミュレーション必須
- Hook や状態管理の変更後は `src/__tests__/simulation.test.ts` でE2Eシミュレーションを実行する
- 新しいHookを実装したら対応するシナリオをシミュレーションテストに追加する
- シミュレーションは本番フロー (Edit→gate→pending-fixes→DENY) を再現する統合テスト

## 設計ドキュメント

- design-v0.1.md — v0.1.0 全体設計
- research-harness-engineering-2026.md — リサーチ結果
- research-claude-code-plugins-2026.md — Plugin 調査結果
