# claude-alfred

Quality butler for Claude Code — Hooks + MCP server + TUI.

## Stack

TypeScript (Bun 1.3+, ESM) / SQLite (bun:sqlite) / Voyage AI (voyage-4-large + rerank-2.5) / TUI (OpenTUI + @opentui/react)

Build: bun build (bundle + compile) / vitest (test) / citty (CLI) / @modelcontextprotocol/sdk (MCP)

## Architecture

alfred = Hook群 (品質の壁) + 知識DB (壁を賢くする) + MCP (Claude Codeのインターフェース) + TUI (品質可視化)

```
User → Claude Code → (alfred hooks: 監視 + コンテキスト注入 + ゲート)
              ↓ 必要な時だけ
           alfred MCP (知識DB)
```

| Weight | Component | Role |
|---|---|---|
| 70% | Hooks (6 events) | 監視、コンテキスト注入、品質ゲート |
| 20% | DB + Voyage AI | 知識蓄積、ベクトル検索 |
| 10% | MCP tool | Claude Code → 知識DBインターフェース |

## Structure

| Package | Role |
|---|---|
| `src/hooks/` | Hook handlers (6): SessionStart, PreCompact, UserPromptSubmit, PostToolUse, PreToolUse, Stop |
| `src/hooks/detect.ts` | 検出ヘルパー (isGitCommit, isTestCommand, isSourceFile等) — bun:sqlite非依存 |
| `src/hooks/pending-fixes.ts` | pending-fixes管理 (PostToolUse→書込, PreToolUse→読込+DENY) |
| `src/hooks/knowledge-search.ts` | Voyage検索ヘルパー (fail-open, error_signature正規化) |
| `src/mcp/` | MCP server (1 tool: `alfred` — search/save/profile/score) |
| `src/store/` | SQLite persistence (projects, knowledge_index, embeddings, quality_events) |
| `src/embedder/` | Voyage AI (voyage-4-large embed + rerank-2.5) |
| `src/profile/` | プロジェクトプロファイリング (言語/テストFW/リンター自動検出) |
| `src/gates/` | CI-style quality gates (.alfred/gates.json) |
| `src/init/` | `alfred init` — MCP/hooks/rules/skills/agents/gates/DB一括セットアップ |
| `src/tui/` | OpenTUI terminal quality dashboard (Bun-only) |
| `src/git/` | Git integration: user.name resolution |
| `src/cli.ts` | CLI entry point (citty dispatch) |

## Commands

```bash
task build       # Build CLI bundle (bun build)
task tui         # Quality dashboard in terminal
task check       # bun tsc --noEmit + Biome lint
task fix         # Biome auto-fix
task test        # bun vitest run
task scan        # Full quality scan (lint/type/test + score)
task clean       # Clean build artifacts
```

**Note**: `bun tsc` / `bun vitest` を使う（`npx` は不要）

## Design Principles

1. **壁 > 情報提示** — DIRECTIVE (100%強制) > CONTEXT (80%遵守)
2. **機械的強制 > 言語的指示** — Hook ゲート > CLAUDE.md ルール
3. **Claude Code 増幅 > 代替** — Plan mode 等のネイティブ機能をパワーアップ
4. **リサーチ駆動** — 効果が実証された手法のみ実装 (see design/research-ai-code-quality-2026.md)
5. **不可視** — ユーザーは alfred を意識しない

## Rules

### Build
- `bun build.ts` after src/ changes — output is `dist/cli.mjs`
- `bun build.ts --compile` for single binary
- **dependencies はゼロ** — bun:sqlite (built-in)、他は全て devDependencies + bun build バンドル

### Configuration
- VOYAGE_API_KEY **必須** — Voyage AI ベクトル検索 (フォールバックなし)
- `alfred init` で ~/.claude/ に全設定配置 (MCP, hooks, rules, skills, agents)

### Hook Design
- Hook handler: short-lived CLI process. 6 hooks: SessionStart, PreCompact, UserPromptSubmit, PostToolUse, PreToolUse, Stop
- PostToolUse (5s): 最重要 — ファイル編集後にlint/type実行、テスト結果解析、git commitゲート、error_resolution Voyage検索注入
- PreToolUse (3s): Edit/Write ブロック可能 — pending-fixes未修正ならDENY
- UserPromptSubmit (10s): 意図分類(排除→キーワード)→テスト先行DIRECTIVE、exemplar Voyage検索注入
- SessionStart (5s): プロファイル注入、品質サマリー注入、conventions注入、zero-config(.alfred/自動作成)
- Stop (3s): pending-fixes WARNING、未テスト変更チェック、品質サマリー保存
- PreCompact (10s): 品質サマリー保存、chapter memory保存
- 二段構え: PostToolUse で検出+DIRECTIVE → PreToolUse でブロック

### Knowledge Types (3 types)
- **error_resolution**: エラー→解決策キャッシュ (Bashエラー時にVoyage検索→自動注入)
- **exemplar**: before/after コード例 (Few-shot注入, research #8)
- **convention**: プロジェクト規約 (SessionStartで注入)

### Skills (2 skills)
- **/alfred:review**: Judge-filtered multi-agent code review (HubSpot 3-criteria: Succinctness/Accuracy/Actionability)
- **/alfred:conventions**: Convention discovery with adoption % + conflict detection

### Quality Gates (.alfred/gates.json)
- on_write: ファイル編集後に lint/type チェック
- on_commit: git commit 後にテスト実行
- 自動検出: package.json から tsc/biome/vitest 等を検出

### Quality Score (0-100)
- gate_write 30% + gate_commit 20% + error_resolution_hit 15% + convention 10% + base 25%
- トレンド: 直近5セッション平均との差分 (improving/stable/declining)

## Troubleshooting

- 修正→実行が3回連続失敗した場合、同じアプローチを繰り返さない。公式ドキュメント・事例を徹底リサーチしてからアプローチを再検討すること

## Milestone Checklist

- マイルストーン完了時に `task scan` を実行し、エラー0件を確認する
- 変更内容に応じて README.md / CLAUDE.md を更新する

## Design Docs

See `design/` for detailed architecture, hook design, MCP schema, and research references.
