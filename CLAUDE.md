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
| `src/hooks/` | Hook handlers: SessionStart, PreCompact, UserPromptSubmit, PostToolUse, PreToolUse, Stop |
| `src/mcp/` | MCP server (1 tool: `alfred` — search/save/profile/score) |
| `src/store/` | SQLite persistence (projects, knowledge_index, embeddings, quality_events) |
| `src/embedder/` | Voyage AI (voyage-4-large, vector search + rerank-2.5) |
| `src/tui/` | OpenTUI terminal quality dashboard (Bun-only) |
| `src/git/` | Git integration: user.name resolution |
| `src/cli.ts` | CLI entry point (citty dispatch) |

## Commands

```bash
task build       # Build CLI bundle (bun build)
task tui         # Quality dashboard in terminal
task check       # tsc --noEmit + Biome lint
task fix         # Biome auto-fix
task test        # vitest
task clean       # Clean build artifacts
```

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
- Plugin 不要 — 直接ファイル配置

### Hook Design
- Hook handler: short-lived CLI process. 6 hooks: SessionStart, PreCompact, UserPromptSubmit, PostToolUse, PreToolUse, Stop
- PostToolUse (5s): 最重要 — ファイル編集後にlint/type実行、テスト結果解析、git commitゲート
- PreToolUse (3s): Edit/Write ブロック可能 — pending-fixes未修正ならDENY
- 二段構え: PostToolUse で検出+DIRECTIVE → PreToolUse でブロック

### Knowledge Types (3 types)
- **error_resolution**: エラー→解決策キャッシュ (Bashエラー時に自動注入)
- **exemplar**: before/after コード例 (Few-shot注入)
- **convention**: プロジェクト規約 (PreToolUseで注入)

### Quality Gates (.alfred/gates.json)
- on_write: ファイル編集後に lint/type チェック
- on_commit: git commit 後にテスト実行
- 自動検出: package.json から tsc/biome/vitest 等を検出

### DB Schema V1
- projects, knowledge_index, embeddings, quality_events
- Voyage vector search only (FTS5 なし)
- rebuildFromScratch pattern

## Troubleshooting

- 修正→実行が3回連続失敗した場合、同じアプローチを繰り返さない。公式ドキュメント・事例を徹底リサーチしてからアプローチを再検討すること

## Quality Gates

- At each meaningful implementation milestone, perform **thorough self-review**
- After self-review, update README.md / CLAUDE.md to reflect changes
- Maintain test coverage at **50% or above**

## Design Docs

See `design/` for detailed architecture, hook design, MCP schema, and research references.
