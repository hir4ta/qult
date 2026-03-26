# claude-alfred

Claude Code の品質バトラー — Hooks + MCP サーバー + TUI。

## スタック

TypeScript (Bun 1.3+, ESM) / SQLite (bun:sqlite) / Voyage AI (voyage-4-large + rerank-2.5) / TUI (OpenTUI + @opentui/react)

ビルド: bun build (バンドル + コンパイル) / vitest (テスト) / citty (CLI) / @modelcontextprotocol/sdk (MCP)

## アーキテクチャ

alfred = Hook群 (品質の壁) + 知識DB (壁を賢くする) + MCP (Claude Codeのインターフェース) + TUI (品質可視化)

```
User → Claude Code → (alfred hooks: 監視 + コンテキスト注入 + ゲート)
              ↓ 必要な時だけ
           alfred MCP (知識DB)
```

| 比重 | コンポーネント | 役割 |
|---|---|---|
| 70% | Hooks (6 events) | 監視、コンテキスト注入、品質ゲート |
| 20% | DB + Voyage AI | 知識蓄積、ベクトル検索 |
| 10% | MCP tool | Claude Code → 知識DBインターフェース |

## 構造

| パッケージ | 役割 |
|---|---|
| `src/hooks/` | Hook ハンドラー (6種): SessionStart, PreCompact, UserPromptSubmit, PostToolUse, PreToolUse, Stop |
| `src/hooks/detect.ts` | 検出ヘルパー (isGitCommit, isTestCommand, isSourceFile等) — bun:sqlite非依存 |
| `src/hooks/pending-fixes.ts` | pending-fixes管理 (PostToolUse→書込, PreToolUse→読込+DENY) |
| `src/hooks/knowledge-search.ts` | Voyage検索ヘルパー (fail-open, error_signature正規化) |
| `src/mcp/` | MCP サーバー (1 tool: `alfred` — search/save/profile/score) |
| `src/store/` | SQLite 永続化 (projects, knowledge_index, embeddings, quality_events) |
| `src/embedder/` | Voyage AI (voyage-4-large embed + rerank-2.5) |
| `src/profile/` | プロジェクトプロファイリング (言語/テストFW/リンター自動検出) |
| `src/gates/` | CI風品質ゲート (.alfred/gates.json) |
| `src/init/` | `alfred init` — MCP/hooks/rules/skills/agents/gates/DB一括セットアップ |
| `src/tui/` | OpenTUI ターミナル品質ダッシュボード (Bun専用) |
| `src/git/` | Git連携: user.name 解決 |
| `src/cli.ts` | CLI エントリポイント (citty ディスパッチ) |

## コマンド

```bash
task build       # CLIバンドルをビルド (bun build)
task tui         # ターミナル品質ダッシュボード
task check       # bun tsc --noEmit + Biome lint
task fix         # Biome 自動修正
task test        # bun vitest run
task scan        # フル品質スキャン (lint/型/テスト + スコア)
task clean       # ビルド成果物を削除
```

**注意**: `bun tsc` / `bun vitest` を使う（`npx` は不要）

## 設計原則

1. **壁 > 情報提示** — DIRECTIVE (100%強制) > CONTEXT (80%遵守)
2. **機械的強制 > 言語的指示** — Hook ゲート > CLAUDE.md ルール
3. **Claude Code 増幅 > 代替** — Plan mode 等のネイティブ機能をパワーアップ
4. **リサーチ駆動** — 効果が実証された手法のみ実装 (see design/research-ai-code-quality-2026.md)
5. **不可視** — ユーザーは alfred を意識しない

## ルール

### ビルド
- `bun build.ts` — src/ 変更後に実行。出力は `dist/cli.mjs`
- `bun build.ts --compile` — シングルバイナリ生成
- **dependencies はゼロ** — bun:sqlite (built-in)、他は全て devDependencies + bun build バンドル

### 設定
- VOYAGE_API_KEY **必須** — Voyage AI ベクトル検索 (フォールバックなし)
- `alfred init` で ~/.claude/ に全設定配置 (MCP, hooks, rules, skills, agents)

### Hook 設計
- Hook ハンドラー: 短命CLIプロセス。6種: SessionStart, PreCompact, UserPromptSubmit, PostToolUse, PreToolUse, Stop
- PostToolUse (5s): 最重要 — lint/typeゲート、convention違反検出、fix_pattern自動蓄積、error_resolution Voyage検索注入、plan構造検証、decision自動蓄積
- PreToolUse (3s): Edit/Write ブロック可能 — pending-fixes(lint/type/convention)未修正ならDENY（修正対象ファイルへのEditは許可）
- UserPromptSubmit (10s): 意図分類→テスト先行DIRECTIVE、Plan Modeテンプレート注入、知識Voyage検索注入
- SessionStart (5s): プロファイル注入、品質サマリー注入、conventions注入、zero-config(.alfred/自動作成)
- Stop (3s): pending-fixes WARNING (stderr出力)、未テスト変更チェック、品質サマリー保存
- PreCompact (10s): 品質サマリー保存、chapter memory保存
- 二段構え: PostToolUse で検出+DIRECTIVE → PreToolUse でブロック

### 知識タイプ (4種、全自動蓄積)
- **error_resolution**: エラー→解決策キャッシュ (自動: Bashエラー→成功検出 / 注入: Bashエラー時にVoyage検索)
- **fix_pattern**: lint/type修正パターン (自動: fail→passサイクルのbefore/after / 注入: 実装時にVoyage検索)
- **convention**: プロジェクト規約 (自動: init時生成 / 注入: SessionStart + Edit後regex違反検出→DENY)
- **decision**: 設計意思決定 (自動: plan Write + commitメッセージ / 注入: plan/design時にVoyage検索)

### Skills (2種)
- **/alfred:review**: Judge フィルタリング付きマルチエージェントコードレビュー (HubSpot 3基準: Succinctness/Accuracy/Actionability)
- **/alfred:conventions**: Convention 検出 + 採用率 + 競合検出

### 品質ゲート (.alfred/gates.json)
- on_write: ファイル編集後に lint/type チェック
- on_commit: git commit 後にテスト実行
- 自動検出: package.json から tsc/biome/vitest 等を検出

### 品質スコア (0-100)
- gate_write 30% + gate_commit 20% + error_resolution_hit 15% + convention 10% + base 25%
- トレンド: 直近5セッション平均との差分 (improving/stable/declining)

## トラブルシューティング

- 修正→実行が3回連続失敗した場合、同じアプローチを繰り返さない。公式ドキュメント・事例を徹底リサーチしてからアプローチを再検討すること

## マイルストーンチェックリスト

- マイルストーン完了時に `task scan` を実行し、エラー0件を確認する
- 変更内容に応じて README.md / CLAUDE.md を更新する

## 設計ドキュメント

`design/` に詳細アーキテクチャ、Hook設計、MCPスキーマ、リサーチ参考文献を配置。
