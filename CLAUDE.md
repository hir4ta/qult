# qult

Claude Code の品質を構造で守る evaluator harness。Claude Code Plugin として配布。

## スタック

TypeScript (Bun 1.3+, ESM) / vitest (テスト) / Biome (lint) / MCP SDK (状態公開)

## コマンド

```bash
bun run build    # bun build (hook.mjs + mcp-server.mjs)
bun run typecheck && bun run lint  # tsc --noEmit + Biome lint
bun run lint:fix # Biome 自動修正
bun run test     # vitest run
```

`bun tsc` / `bun vitest` を使う（`npx` 不要）

## Plugin 構造

```
qult/
├── .claude-plugin/marketplace.json  # マーケットプレイス定義
├── plugin/                          # プラグイン本体
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json             # 5 hooks
│   ├── .mcp.json                    # MCP server
│   ├── skills/                      # 6 skills
│   ├── agents/                      # 3 agents
│   └── dist/                        # バンドル (hook.mjs, mcp-server.mjs)
└── src/                             # ソースコード (開発用)
```

## 設計原則

1. **壁 > 情報提示** — DENY (exit 2) が唯一の強制手段
2. **fail-open** — 全 hook は try-catch で握りつぶす。qult の障害で Claude を止めない
3. **structural guarantee** — 品質を構造で保証する。仮定を stress-test し、崩れたら削除
4. **hooks = 検出 + ブロック、MCP = 情報伝達** — stdout 不使用 (#16538 回避)

## ルール

### ビルド
- `bun build.ts` → `plugin/dist/hook.mjs` + `plugin/dist/mcp-server.mjs`
- **dependencies ゼロ** — 全て devDependencies + bun build バンドル

### Hook 設計 (5 hooks)
- 全 hook は fail-open (try-catch で握りつぶす)
- exit 2 = DENY/block (唯一の強制手段)。stderr に理由を出力
- **stdout は一切使わない** — plugin hook output bug (#16538) を回避
- PostToolUse: gate 実行 → state 書き込み (pending-fixes)
- PreToolUse: pending-fixes チェック → exit 2 (DENY)
- Stop/SubagentStop: 完了条件チェック → exit 2 (block)
- TaskCompleted: Verify テスト実行 → state 書き込み
- PreToolUse (ExitPlanMode): 1回目を DENY してセッション全体の漏れチェックを強制
- 全 state file 書き込みは atomic write (write-to-temp + rename)
- lazyInit: dispatcher 冒頭で .qult/.state/ 初期化 (SessionStart hook の代替)

### MCP Server
- Claude が状態を取得する唯一の経路
- tools: get_pending_fixes, get_session_status, get_gate_config
- instructions で DENY 時の呼び出しルールを Claude に指示

### Gates
- on_write: 編集時 (lint, typecheck) / on_commit: コミット時 (test) / on_review: レビュー時 (e2e)

### 消費者チェック
- 型変更 (types.ts, session-state.ts) は必ず消費者への波及を確認

### Phase Gate (各コミット前に必ず実行)
1. `bun vitest run` — 全テスト pass
2. `bun vitest run src/__tests__/simulation.test.ts` — シミュレーション pass
3. `bun tsc --noEmit && bun biome check src/` — 型 + lint clean
4. `/qult:review` — 独立レビュー (自己評価は機能しない。必ずサブエージェントで実行)
5. コミット — Phase Gate 通過後にのみコミット

### シミュレーション
- Hook や状態管理の変更後は simulation.test.ts にシナリオを追加する
- シミュレーションは本番フロー (Edit→gate→pending-fixes→DENY) を再現する統合テスト
