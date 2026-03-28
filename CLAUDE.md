# qult

Claude Code の品質を構造で守る evaluator harness。

## スタック

TypeScript (Bun 1.3+, ESM) / citty (CLI) / vitest (テスト) / Biome (lint)

## コマンド

```bash
bun run build    # bun build (バンドル)
bun run typecheck && bun run lint  # tsc --noEmit + Biome lint
bun run lint:fix # Biome 自動修正
bun run test     # vitest run
```

`bun tsc` / `bun vitest` を使う（`npx` 不要）

## 設計原則

1. **壁 > 情報提示** — DENY (exit 2) > additionalContext
2. **少ない方が強い** — コンテキスト注入は最小限。Hook注入は20行以内
3. **検証 > 指示** — HOW ではなく WHAT を伝える
4. **fail-open** — 全 hook は try-catch で握りつぶす。qult の障害で Claude を止めない
5. **simplest solution** — 全コンポーネントは load-bearing 仮定を持つ。仮定が崩れたら削除

## ルール

### ビルド
- `bun build.ts` → `dist/cli.mjs`、`bun build.ts --compile` → シングルバイナリ
- **dependencies ゼロ** — 全て devDependencies + bun build バンドル

### Hook 設計
- 全 hook は fail-open (try-catch で握りつぶす)
- exit 2 = DENY/block (唯一の強制手段)。stderr にも理由を出力
- PostToolUse 検出 → PreToolUse ブロックの二段構え
- 全 state file 書き込みは atomic write (write-to-temp + rename)
- **出力スキーマ対応表** (hooks docs 準拠):
  - respond(): SessionStart, PostToolUse
  - deny(): PreToolUse, PermissionRequest
  - block(): Stop, SubagentStop
  - 出力なし (stderr): PostCompact

### Gates
- on_write: 編集時 (lint, typecheck) / on_commit: コミット時 (test) / on_review: レビュー時 (e2e)

### 消費者チェック
- レジストリ変更 (init.ts, types.ts, session-state.ts) は必ず消費者への波及を確認
- 例: init.ts に agent 追加 → doctor.ts, post-compact.ts, テストも更新が必要

### Phase Gate (各コミット前に必ず実行)
1. `bun vitest run` — 全テスト pass
2. `bun vitest run src/__tests__/simulation.test.ts` — シミュレーション pass
3. `bun tsc --noEmit && bun biome check src/` — 型 + lint clean
4. `/qult:review` — 独立レビュー (自己評価は機能しない。必ずサブエージェントで実行)
5. コミット — Phase Gate 通過後にのみコミット

### シミュレーション
- Hook や状態管理の変更後は simulation.test.ts にシナリオを追加する
- シミュレーションは本番フロー (Edit→gate→pending-fixes→DENY) を再現する統合テスト
