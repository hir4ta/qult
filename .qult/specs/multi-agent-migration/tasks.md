# Tasks: multi-agent-migration

## Wave 1: プロジェクト再構築・State 移植

**Goal**: `src/state/`・`src/types.ts`・`src/detector/network.ts` を Node.js 向けに移植し、`tsup` でビルドが通る最小シェルを確立する。既存 `plugin/` は残したまま並行開発を開始できる状態にする。
**Verify**: `bun run typecheck && bun run build && node dist/cli.mjs --version`
**Scaffold**: true

- [x] T1.1: `package.json` を Node.js 配布用に更新する（`bin.qult: ./dist/cli.mjs`、`exports`、`engines: {node: ">=20"}`、`files: ["dist/", "src/templates/bundled/"]`、`devDependencies` に `tsup` と `@types/node` を追加、`@types/bun` を削除）
- [x] T1.2: `tsup.config.ts` を新規作成する（CLI エントリ `src/cli/index.ts` と MCP server エントリ `src/mcp/server.ts` の 2 エントリ、ESM 出力、`.md`/`.toml` を `text` ローダで埋め込む設定）
- [x] T1.3: `tsconfig.json` を Node.js 20 向けに更新する（`target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`、`lib` から `dom` を除去）
- [x] T1.4: `src/types.ts` を移植する（`Bun.*` 参照がないことを確認し、型定義をそのまま `src/types.ts` に配置）
- [x] T1.5: `src/state/fs.ts` を Node.js 移植する（`atomicWrite`・`readJson`・`writeJson` を `node:fs/promises` + `node:os` の `tmpdir()` ベースに実装）
- [x] T1.6: `src/state/paths.ts`・`json-state.ts`・`gate-state.ts`・`spec.ts`・`tasks-md.ts`・`wave-md.ts`・`audit-log.ts`・`config.ts` を移植する（`Bun.*` 参照を `node:fs`・`node:path` に置換し、`QultConfig` の `integrations`/`templates` セクションの型定義を追加）
- [x] T1.7: `src/detector/network.ts` を新規作成する（`isNetworkAvailable(): Promise<boolean>` を `fetch` + `AbortController` で実装）
- [x] T1.8: `src/cli/index.ts` の最小スタブを作成する（`--version` のみ応答するエントリポイント。他サブコマンドは後続 Wave で実装）
- [x] T1.9: `__tests__/state.test.ts` を作成して smoke test を追加する（`atomicWrite` の読み書き往復・`readJson` の存在しないファイルへの fallback を検証）

**Consumers**: 後続全 Wave（`src/state/` は MCP・Detector・CLI の共通依存）

---

## Wave 2: Detector 移植

**Goal**: 5 種の Tier 1 Detector を `src/detector/` に Node.js 対応で移植し、`runAllDetectors` インターフェースを確立する。ネットワーク不可時の自動スキップも動作する状態にする。
**Verify**: `bun run typecheck && bun run test -- --run __tests__/detector`

- [ ] T2.1: `src/detector/index.ts` を新規作成する（`DetectorResult` 型・`DetectorOptions` 型・`runAllDetectors(files, opts)` の実装。スキップされた Detector は `skipped: true` を返す）
- [ ] T2.2: `src/detector/security-check.ts` を移植する（`Bun.file` を `readFileSync` に置換、Semgrep 未インストール時の警告出力を `process.stderr` に統一）
- [ ] T2.3: `src/detector/dep-vuln-check.ts` を移植する（`execFileSync` を `node:child_process` からインポート、実行前に `isNetworkAvailable()` を呼び不可なら skip）
- [ ] T2.4: `src/detector/hallucinated-package-check.ts` を移植する（`fetch` は Node 20 標準のまま利用、実行前に `isNetworkAvailable()` を呼び不可なら skip）
- [ ] T2.5: `src/detector/test-quality-check.ts` と `src/detector/export-check.ts` を移植する（`node:fs`・`node:child_process` のみを使用することを確認）
- [ ] T2.6: 既存の Detector テストを `__tests__/detector/` に移動し Node.js 環境で通るよう修正する（`bunx` 依存の部分を `node:child_process` ベースに差し替え）

**Consumers**: Wave 3（MCP `get_detector_summary` ツール）、Wave 5（`check` サブコマンド）

---

## Wave 3: MCP Server 移植

**Goal**: `src/mcp/server.ts` に stdio JSON-RPC ループを Node.js 版で移植し、全 19 ツールが `npx qult mcp` 経由で動作する状態にする。
**Verify**: `bun run typecheck && bun run build && echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/mcp-server.mjs | grep -q '"tools"'`

- [ ] T3.1: `src/mcp/server.ts` を作成する（既存 `src/mcp-server.ts` の `Bun.stdin`/`Bun.stdout` を `process.stdin`/`process.stdout` に置換し、readline ベースの JSON-RPC ループを移植）
- [ ] T3.2: `src/mcp/tools/spec-tools.ts` を作成する（Spec カテゴリ 5 ツール: `get_active_spec`・`complete_wave`・`update_task_status`・`archive_spec`・`record_spec_evaluator_score` を移植）
- [ ] T3.3: `src/mcp/tools/state-tools.ts` を作成する（State カテゴリ 6 ツール: `get_project_status`・`record_test_pass`・`record_review`・`record_stage_scores`・`record_human_approval`・`record_finish_started` を移植）
- [ ] T3.4: `src/mcp/tools/detector-tools.ts` を作成する（Detector カテゴリ 5 ツール: `get_pending_fixes`・`clear_pending_fixes`・`get_detector_summary`・`get_file_health_score`・`get_impact_analysis`・`get_call_coverage` を移植）
- [ ] T3.5: `src/mcp/tools/gate-tools.ts` を作成する（Gate/Config カテゴリ 3 ツール: `disable_gate`・`enable_gate`・`set_config` を移植）
- [ ] T3.6: 既存 `src/mcp-server.test.ts` を `__tests__/mcp/server.test.ts` に移植する（JSON-RPC リクエスト/レスポンスの往復・`tools/list` 応答に全 19 ツール名が含まれることを検証）

**Consumers**: Wave 5（`mcp` サブコマンドが `src/mcp/server.ts` を呼び出す）、全 AI ツールの MCP クライアント

---

## Wave 4: Integration Registry + テンプレート

**Goal**: `IntegrationBase` インターフェース・4 具象クラス・テンプレート renderer・AGENTS.md 生成ロジックを実装する。各 Integration の `generateConfigFiles` と `registerMcpServer` が単体テストで検証できる状態にする。
**Verify**: `bun run typecheck && bun run test -- --run __tests__/integrations __tests__/templates`

- [ ] T4.1: `src/integrations/base.ts` を作成する（`IntegrationBase` インターフェース・`GenerationContext` 型・パストラバーサル防止ガードを定義）
- [ ] T4.2: `src/integrations/registry.ts` を作成する（組み込み 4 Integration の一覧・`detect(projectRoot)` で使用ツールを自動検出する関数・`resolve(key)` で Integration インスタンスを返す関数を実装）
- [ ] T4.3: `src/integrations/claude.ts`・`codex.ts`・`cursor.ts`・`gemini.ts` を作成する（各クラスの `detect()`・`generateConfigFiles()`・`registerMcpServer()` を実装し、MCP 設定スニペットをクラス内定数として管理）
- [ ] T4.4: `src/templates/renderer.ts` を作成する（`renderTemplate(template, vars)` 関数と `detectUndefinedVars(template, vars)` 関数を実装。`/\{\{([A-Z0-9_]+)\}\}/g` で全プレースホルダーを抽出し未定義変数があれば `UndefinedVariableError` を throw）
- [ ] T4.5: `src/templates/agents-md.ts` を作成する（`AGENTS.md` の新規生成と、既存ファイルへの `@generated by qult` マーカーブロック追記ロジックを実装。マーカーブロックの再生成時は既存ブロックを置換）
- [ ] T4.6: `src/templates/bundled/` にテンプレートを配置する（`commands/`・`rules/`・`constitution.md` を既存 `plugin/rules/` と `plugin/skills/` から抽出して agent-neutral な `{{VAR}}` 形式で作成）
- [ ] T4.7: `__tests__/integrations/` と `__tests__/templates/` にユニットテストを追加する（renderer の未定義変数 throw・各 Integration の `detect()` 判定ロジック・AGENTS.md の追記冪等性を検証）

**Consumers**: Wave 5（CLI の `init`・`update`・`add-agent` が Integration Registry を呼び出す）

---

## Wave 5: CLI 実装

**Goal**: 5 サブコマンド（`init`・`update`・`check`・`add-agent`・`mcp`）を備えた完全な CLI を実装し、冪等性・`@generated` マーカー更新・`--json` 出力・非 TTY フォールバックがすべて動作する状態にする。
**Verify**: `bun run typecheck && bun run build && node dist/cli.mjs --help && node dist/cli.mjs --version`

- [ ] T5.1: `src/cli/index.ts` を完成させる（`process.argv` 走査の手書きパーサ・サブコマンド dispatch・`--version`/`--help`/`--json` の全グローバルオプション処理・Node.js バージョンチェック（<20 なら exit 1）を実装）
- [ ] T5.2: `src/cli/prompt.ts` を作成する（`process.stdout.isTTY` 判定・`node:readline` の `question()` を使った手書き select UI を実装。非 TTY 時は呼ばれない前提で設計）
- [ ] T5.3: `src/cli/commands/init.ts` を作成する（Integration 自動検出 → TTY 選択 / 非 TTY フォールバック → AGENTS.md 生成 → 各 Integration ファイル生成 → `.qult/config.json` の `integrations.enabled` 書き込み → 冪等性チェックを実装。`--force` で確認スキップ）
- [ ] T5.4: `src/cli/commands/update.ts` を作成する（`config.json` から enabled 読み込み → 各 Integration の `@generated` マーカーブロックのみを最新テンプレートで置換。`.qult/specs/` と `.qult/state/` は変更しない）
- [ ] T5.5: `src/cli/commands/check.ts` を作成する（`.qult/state/current.json` から `active_spec`・`test_passed_at`・`review_completed_at`・`pending_fixes` を読み込み表示。`--detect` フラグで 5 Detector を実行し HIGH 以上が存在すれば exit 1。`--json` で JSON 出力。読み取り専用（state への書き込み禁止））
- [ ] T5.6: `src/cli/commands/add-agent.ts` を作成する（単一 Integration を追加。既存ファイルがあれば exit 1・`--force` で上書き。未知の key は利用可能 integration 名リストをエラーに含めて exit 1）
- [ ] T5.7: `__tests__/cli/` に統合テストを追加する（`--version` の出力文字列が `package.json` の `version` と一致すること・`check` の読み取り専用性・`add-agent` の未知 key エラーメッセージを検証）

**Consumers**: Wave 6（E2E smoke test が CLI を直接呼び出す）

---

## Wave 6: `plugin/` 削除・npm 配布準備

**Goal**: 旧 `plugin/` ディレクトリ・`build.ts`・`src/hooks/`（存在する場合）を削除し、npm 配布物として完結した状態を確認する。E2E smoke test が全通過することを検証してから削除を実行する。
**Verify**: `bun run typecheck && bun run test && bun run build && npm pack --dry-run && node dist/cli.mjs init --help`

- [ ] T6.1: E2E smoke test `__tests__/e2e/init.test.ts` を追加する（一時ディレクトリを作成し `node dist/cli.mjs init --agent claude --force` を実行して `.mcp.json`・`AGENTS.md`・`.claude/commands/` の生成を検証。その後 `node dist/cli.mjs mcp` が起動して `tools/list` に応答することを確認）
- [ ] T6.2: `plugin/` ディレクトリを削除する（`plugin/dist/`・`plugin/rules/`・`plugin/skills/`・`plugin/agents/`・`plugin/.claude-plugin/` を含む全体を削除）
- [ ] T6.3: `build.ts`（旧 Bun ビルドスクリプト）と `src/hooks/`（存在する場合）を削除する
- [ ] T6.4: `package.json` の `files`・`bin`・`exports`・`scripts` を最終確認する（`npm pack --dry-run` の出力で `dist/cli.mjs`・`dist/mcp-server.mjs`・`src/templates/bundled/**` が含まれ、`plugin/`・`src/`（`templates/bundled/` 除く）・`__tests__/` が除外されていることを確認）
- [ ] T6.5: `.gitignore` を更新する（`plugin/dist/` の除外エントリを削除し、`dist/` のみを gitignore に追加。`.qult/state/` の ignore が残っていることを確認）
- [ ] T6.6: `README.md` を `npx qult` ベースで全面更新する（インストール方法・4 サブコマンドの使用例・4 Integration の対応状況・MCP server の登録方法・`.qult/` ディレクトリ規約を記載）

**Consumers**: 全 AI ツールユーザー（公開後）
