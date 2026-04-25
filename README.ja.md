# qult

> **qu**ality + c**ult** — 品質への狂信。
> マルチエージェント対応の SDD + ハーネスエンジニアリングツール。`npx` コマンドとして配布。

[English / README.md](README.md)

## qult とは

qult はプロジェクトに **Spec-Driven Development ワークフロー** と **ステートフル MCP サーバー** をインストールします。MCP に対応した任意の AI コーディングツール — Claude Code・OpenAI Codex・Cursor・Gemini CLI — から同じワークフローで利用できます。

各ツール固有の設定ファイルを自動生成し、`AGENTS.md` を single source of truth として維持し、spec / wave / test / review の状態を `.qult/` 配下で追跡します。

[GitHub spec-kit](https://github.com/github/spec-kit) と [OpenSpec](https://github.com/Fission-AI/OpenSpec) の影響を受けています。v1.0 までは Claude Code Plugin として配布していましたが、v1.1 からはツール非依存の CLI に作り変えました。

## クイックスタート

```bash
# プロジェクトディレクトリで
npx qult init                # .claude/ / .cursor/ / .codex/ / .gemini/ を自動検出
npx qult init --agent claude # 明示指定
npx qult check               # SDD 状態のスナップショット
```

`init` は以下を生成:

- `AGENTS.md`（ワークフローの単一ソース、`<!-- @generated -->` ブロック付き）
- 各ツール用 context ファイル (`CLAUDE.md`・`GEMINI.md`・`.cursor/rules/qult.mdc`)
- 各ツール用スラッシュコマンド (`.claude/commands/qult-*.md`・`.gemini/commands/qult-*.toml`)
- 各ツール用 MCP サーバー登録 (`.mcp.json`・`.cursor/mcp.json`・`.gemini/settings.json`・`.codex/config.toml`)
- `.qult/config.json`（有効化された integration 一覧）

## サブコマンド

| コマンド | 内容 |
|---------|------|
| `qult init` | qult を初期化、integration を選択 |
| `qult update` | integration 設定ファイルを最新テンプレートで更新（`@generated` ブロックのみ） |
| `qult check [--detect] [--json]` | SDD 状態を表示、`--detect` で Tier 1 detector 実行 |
| `qult add-agent <key> [--force]` | init 後に integration を追加 |
| `qult mcp` | stdio JSON-RPC MCP サーバー起動（ツールから呼ばれる、通常ユーザーは実行しない） |

共通フラグ: `--agent <key>`（init のみ）、`--force`、`--json`、`--version`、`--help`。

## SDD ライフサイクル（MCP サーバー駆動）

1. `/qult:spec <name> <description>` — `.qult/specs/<name>/{requirements,design,tasks}.md` をドラフト。clarify ラウンド必須、各フェーズに品質ゲート。
2. `/qult:wave-start` → 実装 → `/qult:wave-complete` — Wave 単位、`[wave-NN]` プレフィックス付き conventional commit と range 整合性検証。
3. `/qult:review` — 独立 4 段階レビュー（spec compliance / code quality / security / adversarial）。5 ファイル以上変更時に commit 前必須。
4. `/qult:finish` — spec をアーカイブし、merge / PR / hold / discard を選択。

## 対応 AI ツール

- **Claude Code** — `.claude/commands/`・`CLAUDE.md`・`.mcp.json`
- **OpenAI Codex CLI** — `AGENTS.md`・`.codex/config.toml`
- **Cursor** — `.cursor/rules/qult.mdc`・`.cursor/mcp.json`
- **Gemini CLI** — `.gemini/commands/*.toml`・`GEMINI.md`・`.gemini/settings.json`

4 ツールすべてが同じ `qult` MCP サーバー (`npx qult mcp`) を登録するため、エディタを越えてワークフローツールが同一の挙動になります。

## `.qult/` ディレクトリ規約

```
.qult/
├── config.json         # committed: integrations.enabled / review threshold 等
├── specs/              # committed: spec markdown
│   ├── <name>/{requirements,design,tasks}.md + waves/wave-NN.md
│   └── archive/<name>/ # 完了済み spec
└── state/              # gitignored: 一時的な test/review/finish 状態
```

## 動作要件

- Node.js 20 以降
- MCP に対応した AI コーディングツール（上記 4 種のいずれか。`generic`（AGENTS.md のみ）フォールバックは将来対応予定）
- 任意: `semgrep`（security-check 用）、`osv-scanner`（dep-vuln-check 用）

## 開発

```bash
npm install
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run lint       # biome check src/
npm run build      # tsup → dist/{cli,mcp-server}.js
```

## ライセンス

MIT
