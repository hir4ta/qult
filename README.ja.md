# qult

> **qu**ality + c**ult** — 品質への狂信。
> Claude がより品質高く、漏れなくコードを書けるよう補助する Claude Code プラグイン。

[English / README.md](README.md)

## qult は何をするか

qult は **Claude のための補助ツール** です。完璧なハーネスエンジニアリング実装ではありません。Claude に次を提供します:

- **Workflow rules** を `~/.claude/rules/qult-*.md` に配置 — Plan → Implement → Review → Finish
- **独立 4 段レビュー** (`/qult:review`) — spec / quality / security / adversarial のレビュアーが別 subagent で動作 (sonnet × 2 + opus × 2)。実装モデルは自分のコードをレビューしない。
- **構造化プラン** (`/qult:plan-generator` + `plan-evaluator`) — 実装前にプランをスコアリング
- **Tier 1 Detector** を MCP 経由で提供 — セキュリティパターン、依存脆弱性、幻覚パッケージ、テスト品質、export 破壊変更。レビュアーの ground truth。

以上。複雑度メトリクス、taint 追跡、フライホイール、SBOM 等は v0.30 で削除。**コードを読めば Claude が判断できる事は自動化しない**方針。

## インストールするメリット

| qult なし | qult あり |
|---|---|
| Claude が自分のコードをレビュー（自己バグの 64.5% を見逃す¹） | 別コンテキストの独立レビュアー |
| プランが膨張 or consumer を見逃す | plan-evaluator が Feasibility / Completeness / Clarity でスコアリング |
| シークレット、OWASP パターン、脆弱依存が通る | Detector がレビュアーの ground truth として検出 |
| 「テスト通ったから出荷」 | `/qult:status` + `/qult:finish` チェックリスト |
| プロジェクト知識がチャット内にしかない | 永続状態を `~/.qult/qult.db` に保存 |

¹ [AI Code Review Self-Review Failure](https://www.augmentedswe.com/p/ai-code-review-security)

## インストール

```bash
# Bun が必要: https://bun.sh
brew install semgrep         # 推奨 (security reviewer 用)
brew install osv-scanner     # 推奨 (dep-vuln-check 用)

/plugin marketplace add hir4ta/qult
/plugin install qult@qult
/qult:init                   # ツールチェーン検出（任意の言語）、rules 配布
```

プロジェクトディレクトリにファイルは作成されません。状態は `~/.qult/qult.db`、ルールは `~/.claude/rules/qult-*.md`。

## コマンド

| コマンド | 用途 |
|---|---|
| `/qult:init` | セットアップ / 再設定（冪等） |
| `/qult:status` | 現在の状態（pending fixes, tests, review） |
| `/qult:plan-generator` | 実装計画の生成 + 評価 |
| `/qult:review` | 4 段独立レビュー |
| `/qult:finish` | ブランチ完了チェックリスト |
| `/qult:debug` | 構造化された原因調査 |
| `/qult:skip` | ゲートの一時無効化 |
| `/qult:config` | 閾値の調整 |
| `/qult:doctor` | 健全性チェック |
| `/qult:uninstall` | クリーンアンインストール |

## レビュアーモデル構成 (B+ プラン)

| ステージ | モデル | 理由 |
|---|---|---|
| spec-reviewer | sonnet | プランとの機械的照合 |
| quality-reviewer | sonnet | 設計判断、高速 |
| **security-reviewer** | **opus** | 高リスク（AI コードの 45% が脆弱²） |
| **adversarial-reviewer** | **opus** | 最終番人 — エッジケース、サイレント障害 |
| plan-generator | sonnet | 生成タスク |
| **plan-evaluator** | **opus** | 仕様品質ゲート — 悪いプランは下流全てを腐らせる |

`review.models.*` 設定または `QULT_REVIEW_MODEL_*` 環境変数で上書き可能。

² [Veracode GenAI Code Security](https://www.veracode.com/blog/genai-code-security-report/)

## アンインストール

```bash
/plugin → qult を削除
rm -f ~/.claude/rules/qult-*.md
rm -rf ~/.qult          # 任意 — セッション履歴 DB を削除
```

## v0.29 → v0.30 の変更

- 削除: flywheel、tree-sitter dataflow、複雑度メトリクス、mutation-testing、SBOM、LSP 統合、escalation カウンター、`/qult:explore`、`/qult:writing-skills`、MCP tool 6 個、detector 2 個
- `/qult:init` が Claude の判断でツールチェーンを検出（ハードコード言語リスト廃止）
- 合計: 約 5000 行削減、プラグインインストールサイズ 10MB+ 軽量化（WASM 削除）

## 哲学

```
qult は Claude の補助ツール、完璧なハーネスではない。
ハーネスエンジニアリング研究は設計の参考であって、設計そのものではない。
迷ったら軽い方を選ぶ。
Claude が単独でできない事だけ追加する。
```

## スタック

TypeScript / Bun 1.3+ / bun:sqlite / vitest / Biome
