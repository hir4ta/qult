# qult

> **qu**ality + c**ult** — 品質への狂信。
> Claude が見落とすバグを拾う Claude Code プラグイン。

[English / README.md](README.md)

## qult は何をするか

qult は **Claude のための品質補助ツール** です。Claude が単体で確実にできない 5 つの能力を足します:

1. **独立レビュー** (`/qult:review`) — 4 つのレビュアー (spec / quality / security / adversarial) が**別 subagent コンテキスト**で動作し、モデル多様性（sonnet × 2 + opus × 2）で相関エラーを低減。実装モデルは自分のコードを採点しない。研究によれば自己レビューは自身のバグの **64.5% を見逃す**¹。
2. **独立プラン評価** (`/qult:plan-generator` + `plan-evaluator`) — 独立レビューと同じアーキテクチャ。`plan-generator` がプランを出し、`plan-evaluator` が**別コンテキスト**で Feasibility / Completeness / Clarity をスコアリング。閾値未達なら再生成する。
3. **外部 SAST + CVE データ** — `security-check` が Semgrep ルールセットを統合、`dep-vuln-check` が osv-scanner でインストール済みパッケージを照会。Claude 単体では SAST を実行できず、CVE データベースも知らない。
4. **幻覚パッケージ検出** — install コマンド実行前に、`hallucinated-package-check` がパッケージがレジストリに実在するか確認。AI 支援コミットは不正なパッケージ名を **ベースラインの 2 倍** の率で混入させる²。
5. **一貫性保証のテスト品質チェック** — `test-quality-check` が empty test / always-true / trivial assertion を **毎回** flag。レビュアーが test file を読んだ時に気づくのは条件付きだが、detector は reviewer の注意リソースを消費せず常に検出。

それだけです。hooks なし、workflow 強奪なし。qult は **toolbox（工具箱）** であって guardrail（ガードレール）ではない — 鋭い道具を揃えておき、使うかは architect が決める。

¹ [AI Code Review Self-Review Failure](https://www.augmentedswe.com/p/ai-code-review-security) · ² [GitGuardian 2026](https://blog.gitguardian.com/state-of-secrets-sprawl-2026/)

## 品質底上げの実測

| Claude 単体の弱点 | qult が補う機能 | 観測可能な効果 |
|---|---|---|
| 自己レビューの死角 | 独立 4 段レビュー | 作者が見逃したバグを捕捉 |
| プラン作成者の死角 | plan-evaluator（別コンテキスト） | 欠落ファイル / エッジケース / consumer 未更新を実装前に検出 |
| SAST を実行しない | Semgrep 統合 | OWASP Top 10 パターンを検出 |
| CVE データを知らない | osv-scanner 統合 | コミット前に脆弱な依存を発見 |
| パッケージ名の幻覚 | レジストリ確認 | typosquatting / 存在しないパッケージを阻止 |
| レビュー注意ドリフト | test-quality detector 常時発動 | empty test / trivial assertion を毎回検出 |

**qult が最強に効く場面:**
- 本番コード、5+ ファイル変更
- セキュリティ重要領域（認証、入力処理、暗号、外部 API）
- 依存変更を伴う作業（新規パッケージ、バージョン上げ）
- state 継続性が必要な長期機能開発

**qult が overkill な場面:**
- 1 ファイル quick fix
- 使い捨てプロトタイプ
- Spike / 実験
- → レビューをスキップするだけ。hook がないので何もブロックしない。

## インストール

```bash
# Bun が必要: https://bun.sh
brew install semgrep         # 推奨 (security reviewer が利用)
brew install osv-scanner     # 推奨 (dep-vuln-check が利用)

/plugin marketplace add hir4ta/qult
/plugin install qult@qult
/qult:init                   # rules を ~/.claude/rules/ に配布
```

プロジェクトディレクトリにファイルは作成されません。状態は `~/.qult/qult.db`、ルールは `~/.claude/rules/qult-*.md`。

プラグイン更新後は `/qult:update` で rules を refresh してください。

## コマンド

| コマンド | 用途 |
|---|---|
| `/qult:init` | rules 配布 + legacy cleanup（プラグインインストール後に 1 回） |
| `/qult:update` | rules refresh（プラグイン更新後） |
| `/qult:status` | 現状（pending fixes, tests, review） |
| `/qult:plan-generator` | 実装計画の生成 + 評価 |
| `/qult:review` | 4 段独立レビュー |
| `/qult:finish` | ブランチ完了チェックリスト |
| `/qult:debug` | 構造化された原因調査 |
| `/qult:skip` | detector の一時無効化 |
| `/qult:config` | 閾値とレビュアーモデルの調整 |
| `/qult:doctor` | 健全性チェック |
| `/qult:uninstall` | クリーンアンインストール |

## レビュアーモデル構成

| ステージ | モデル | 理由 |
|---|---|---|
| spec-reviewer | sonnet | プランとの機械的照合 |
| quality-reviewer | sonnet | 設計判断、高速 |
| **security-reviewer** | **opus** | 高リスク — **AI コードの 45% が脆弱**³ |
| **adversarial-reviewer** | **opus** | 最終番人 — エッジケース、サイレント障害 |
| plan-generator | sonnet | 生成タスク |
| **plan-evaluator** | **opus** | 仕様品質ゲート — 悪いプランは下流全てを腐らせる |

`review.models.*` 設定または `QULT_REVIEW_MODEL_*` 環境変数で上書き可能。

³ [Veracode GenAI Code Security](https://www.veracode.com/blog/genai-code-security-report/)

## 正直な限界

- **助言であって強制ではない**: `~/.claude/rules/qult-*.md` のルールはプロンプトレベルの誘導。研究（AgentPex）によれば **エージェントのトレースの 83% に少なくとも 1 件の手続き的違反** が含まれる。ルールは概ね守られるが信頼できるほどではない。価値を引き出すには architect が能動的に skill を起動する必要がある（もしくは skip を受け入れる）。
- **レビューはトークンコストが重い**: `/qult:review` は 4 subagent が diff を読む。中規模変更で 40-100k トークン追加。本番コードなら元が取れるが、小さな修正はスキップ推奨。
- **Detector は TS 偏りのパターン/AST ベース**: security-check と test-quality-check は多言語基本対応だが、Python/Go/Rust は精度が落ちる。

## アンインストール

```bash
/plugin → qult を削除
rm -f ~/.claude/rules/qult-*.md
rm -rf ~/.qult          # 任意 — セッション履歴 DB を削除
```

## 哲学

```
qult は Claude の補助ツール、完璧なハーネスではない。
ハーネスエンジニアリング研究は設計の参考であって、設計そのものではない。
迷ったら軽い方を選ぶ。
Claude が単独でできない事だけ追加する。
```

## スタック

TypeScript / Bun 1.3+ / bun:sqlite / vitest / Biome
