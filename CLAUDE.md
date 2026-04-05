# qult

**Quality by Structure, Not by Promise.** Claude Code の品質を構造で守る evaluator harness。Claude Code Plugin として配布。

## 哲学

- **The Wall doesn't negotiate** — プロンプトは提案。hooks は強制。品質を約束に委ねない
- **architect が設計し、agent が実装する** — 人間は何を作るかを決める。AIはどう作るかを実行する
- **Proof or Block** — 証拠なき完了宣言は構造的にブロック
- **fail-open** — qult の障害で開発を止めない。壊れたら道を開ける

## スタック

TypeScript (Bun 1.3+, ESM) / vitest (テスト) / Biome (lint) / raw JSON-RPC MCP (状態公開)

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
│   ├── hooks/hooks.json             # 7 hooks
│   ├── .mcp.json                    # MCP server
│   ├── skills/                      # 12 skills
│   ├── agents/                      # 6 agents
│   ├── bin/qult-gate                # CLI ツール
│   ├── output-styles/               # 出力スタイル
│   ├── .lsp.json                    # LSP server 設定
│   ├── settings.json                # デフォルトエージェント設定
│   └── dist/                        # バンドル (hook.mjs, mcp-server.mjs)
└── src/                             # ソースコード (開発用)
```

## 設計原則

1. **The Wall > 情報提示** — DENY (exit 2) が唯一の強制手段
2. **fail-open** — 全 hook は try-catch で握りつぶす。qult の障害で Claude を止めない
3. **Proof or Block** — 品質を構造で保証する。仮定を stress-test し、崩れたら削除
4. **hooks = 検出 + ブロック、MCP = 情報伝達** — stdout 不使用 (#16538 回避)

## ルール

### ビルド

- `bun build.ts` → `plugin/dist/hook.mjs` + `plugin/dist/mcp-server.mjs`
- **dependencies ゼロ** — 全て devDependencies + bun build バンドル

### Hook 設計 (7 hooks)

- 全 hook は fail-open (try-catch で握りつぶす)
- exit 2 = DENY/block (唯一の強制手段)。stderr に理由を出力
- **enforcement hooks は stdout 不使用** — plugin hook output bug (#16538) を回避
- SessionStart: .qult/.state/ 初期化、stale ファイル掃除、startup/clear 時のみ pending-fixes クリア
- PostToolUse: gate 並列実行 (Promise.allSettled) → state 書き込み (pending-fixes)
- PreToolUse: pending-fixes チェック → exit 2 (DENY)。Bash は `if: "Bash(git commit*)"` で絞り込み
- Stop/SubagentStop: 完了条件チェック → exit 2 (block)
- TaskCompleted: Verify テスト実行 → state 書き込み
- PostCompact: compaction 後に pending-fixes と session 状態を stdout で再注入
- PreToolUse (ExitPlanMode): 1回目を DENY してセッション全体の漏れチェックを強制
- 全 state file 書き込みは atomic write (write-to-temp + rename)
- lazyInit: SessionStart が発火しない環境向けの fallback

### MCP Server

- Claude が状態を取得・操作する経路
- raw stdio JSON-RPC 実装 (SDK 依存なし)
- 読み取り: get_pending_fixes, get_session_status, get_gate_config, get_detector_summary
- 分析: get_harness_report, get_handoff_document, get_metrics_dashboard
- 操作: disable_gate, enable_gate, clear_pending_fixes, set_config
- 記録: record_review, record_test_pass, record_stage_scores, record_human_approval
- disable_gate は gate 名をバリデーション（gates.json のキー + "review", "security-check", "dead-import-check", "duplication-check"）
- MCP tool の呼び出しルールは MCP server instructions で注入（プロジェクトにファイル配置しない）

### Config 優先順位

- DEFAULTS < `${CLAUDE_PLUGIN_DATA}/preferences.json` < `.qult/config.json` < `QULT_*` env

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

### Claude Code 公式仕様の調査

- Claude Code の hooks、plugins、skills、agents、MCP 等の公式仕様を調べるときは `claude-code-guide` エージェントを必ず使う
- WebSearch や WebFetch で独自にリサーチしに行かないこと
