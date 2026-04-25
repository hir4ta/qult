# qult

> **qu**ality + c**ult** — 品質への狂信。
> AI コーディングツール向け Spec-Driven Development + ハーネスエンジニアリングを `npx` 一発で。

[English / README.md](README.md)

## qult ができること

`qult` はプロジェクトに **構造化された SDD ワークフロー** をインストールします。どの AI コーディングツールを使っても同じ Spec-Driven Development プロセスが回せるようになります — clarify ラウンド必須の spec ドラフト、コミット境界に紐付いた Wave 分割、独立 4 段レビュー、そしてテスト pass / レビュー完了 / detector 検出結果まで含めた状態管理を、すべて `.qult/` 配下のバージョン管理対象ファイルとして追跡します。

加えて MCP サーバーが同梱されており、AI ツールから状態を監査可能な形で直接読み書きできます。ワークフローは **Claude Code**・**OpenAI Codex CLI**・**Cursor**・**Gemini CLI** のいずれでも同一に動作します。

## 機能

- **5 ステップライフサイクル**: spec → wave-start → 実装 → wave-complete → review → finish
- **clarify 必須** — spec を確定する前に必ず質疑応答ラウンドを通す
- **フェーズ別品質ゲート** — requirements / design / tasks をそれぞれ独立に採点
- **Wave 単位コミット** — `[wave-NN]` プレフィックス付き conventional commit と SHA range 整合性を強制
- **独立 4 段レビュー** — spec compliance / code quality / security / adversarial
- **Tier 1 detector** — セキュリティ・依存脆弱性・ハルシネーションパッケージ・テスト品質・破壊的 export 変更
- **AGENTS.md を single source of truth** に — 各ツール固有ファイルは `@AGENTS.md` で参照
- **冪等な更新** — `qult update` は `@generated` ブロックのみを更新、ユーザー編集箇所は保持
- **MCP サーバー** — AI ツールが 20 個の型付きツール経由で SDD 状態を読み書き可能

## クイックスタート

```bash
# 即試す（インストール不要、どのプロジェクトでもOK）
npx -y @hir4ta/qult init

# 普段使いはグローバルインストール推奨（MCP 起動が高速・オフライン可）
npm i -g @hir4ta/qult
qult init

# pnpm / bun ユーザー向け
pnpm dlx @hir4ta/qult init
bunx -y @hir4ta/qult init
```

init 後は、AI ツールから `/qult-spec`・`/qult-wave-start`・`/qult-wave-complete`・`/qult-review`・`/qult-finish` がスキル / スラッシュコマンドとして利用可能になります。

## コマンド

| コマンド | 内容 |
|---------|------|
| `qult init [--agent <key>] [--force]` | qult を初期化、AI ツール integration を選択 |
| `qult update` | 設定ファイルを最新テンプレートで更新（`@generated` ブロック以外は保持） |
| `qult check [--detect] [--json]` | SDD 状態を表示、`--detect` で Tier 1 detector 実行 |
| `qult add-agent <key> [--force]` | init 後に integration を追加 |
| `qult mcp` | MCP サーバー起動（AI ツールから呼ばれる、手動実行は不要） |

共通フラグ: `--force`（プロンプトなしで上書き）、`--json`（CI 向け出力）、`--version`、`--help`。

## SDD ライフサイクル

```
1. /qult:spec <name> <description>
   ├── requirements.md ドラフト（clarify 必須、スコア ≥ 18/20）
   ├── design.md ドラフト（スコア ≥ 17/20）
   └── tasks.md ドラフト（スコア ≥ 16/20）

2. /qult:wave-start  →  タスク実装  →  /qult:wave-complete
   （Wave ゲート: range 整合性 → test pass → detector → conventional commit）

3. /qult:review
   └── 4 つの独立レビュアー: spec / quality / security / adversarial

4. /qult:finish
   └── spec をアーカイブして merge / PR / hold / discard
```

## 対応 AI ツール

| ツール | 生成ファイル |
|------|-------------|
| **Claude Code** | `.claude/commands/`・`CLAUDE.md`・`.mcp.json` |
| **OpenAI Codex CLI** | `AGENTS.md`・`.codex/config.toml` |
| **Cursor** | `.cursor/rules/qult.mdc`・`.cursor/mcp.json` |
| **Gemini CLI** | `.gemini/commands/*.toml`・`GEMINI.md`・`.gemini/settings.json` |

4 ツールすべてが同一の `qult` MCP サーバーを登録するため、エディタを越えてワークフローツールの挙動が一致します。

## `.qult/` ディレクトリ

```
.qult/
├── config.json         # committed: 有効化 integration / review 閾値
├── specs/
│   ├── <name>/{requirements,design,tasks}.md + waves/wave-NN.md
│   └── archive/        # 完了済み spec
└── state/              # gitignored: 一時的な test/review/finish 状態
```

## 動作要件

- Node.js 20 以降
- MCP に対応した AI コーディングツール（上記 4 種のいずれか）

### 推奨（detector のカバレッジを強化）

どちらも未インストール時は自動スキップ。qult 本体が失敗することはない。

- **[osv-scanner](https://github.com/google/osv-scanner)** — Google 製の OSS lockfile 脆弱性スキャナー。`dep-vuln-check` が依存パッケージの既知 CVE を検出可能になる。インストール: `brew install osv-scanner` あるいはリリースバイナリ取得。
- **[semgrep](https://semgrep.dev)** — オープンソース静的解析ツール。`semgrep` が PATH 上にあり、かつ `.qult/config.json` の `security.enable_semgrep: true`（または `QULT_ENABLE_SEMGREP=1`）の場合、`security-check` が qult 組み込みパターンマッチャーと並行して semgrep を実行する。インストール: `brew install semgrep` または `pip install semgrep`。ルールパック上書き: `QULT_SEMGREP_CONFIG`（デフォルト: `auto`）。

## ライセンス

MIT
