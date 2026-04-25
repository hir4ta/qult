# qult

> **qu**ality + c**ult** — 品質への狂信。
> Claude が見落とすバグを拾う Claude Code プラグイン。

[English / README.md](README.md)

## qult は何をするか

qult は **Claude のための品質補助ツール** です。Claude が単体で確実にできない能力を追加します:

1. **Spec-Driven Development パイプライン** (`/qult:spec`) — `requirements.md` (EARS 記法) → 必須の `/qult:clarify` ラウンド → `design.md` → `tasks.md` (Wave 分割) を生成し、各フェーズに独立した `spec-evaluator` ゲートを設置。Markdown が single source of truth で、コードと一緒にコミットされる。
2. **Wave ベース実装** — Wave = 単独で test pass する境界のかたまり。`/qult:wip` で WIP コミット (`[wave-NN]` prefix 自動付与)、`/qult:wave-complete` で test + Tier-1 detector + Range 記録 + コミット。レビュアーは `git log --grep '\[wave-02\]'` で各 Wave の実装内容を正確に把握できる。
3. **独立レビュー** (`/qult:review`) — 4 つのレビュアー (spec / quality / security / adversarial) が**別 subagent コンテキスト**で動作し、モデル多様性（sonnet × 2 + opus × 2）で相関エラーを低減。実装モデルは自分のコードを採点しない。研究によれば自己レビューは自身のバグの **64.5% を見逃す**¹。
4. **外部 SAST + CVE データ** — `security-check` が Semgrep ルールセットを統合、`dep-vuln-check` が osv-scanner でインストール済みパッケージを照会。Claude 単体では SAST を実行できず、CVE データベースも知らない。
5. **幻覚パッケージ検出** — install コマンド実行前に、`hallucinated-package-check` がパッケージがレジストリに実在するか確認。AI 支援コミットは不正なパッケージ名を **ベースラインの 2 倍** の率で混入させる²。
6. **一貫性保証のテスト品質チェック** — `test-quality-check` が empty test / always-true / trivial assertion を **毎回** flag。レビュアーが test file を読んだ時に気づくのは条件付きだが、detector は reviewer の注意リソースを消費せず常に検出。

それだけです。hooks なし、workflow 強奪なし。qult は **toolbox（工具箱）** であって guardrail（ガードレール）ではない — 鋭い道具を揃えておき、使うかは architect が決める。

¹ [AI Code Review Self-Review Failure](https://www.augmentedswe.com/p/ai-code-review-security) · ² [GitGuardian 2026](https://blog.gitguardian.com/state-of-secrets-sprawl-2026/)

## 品質底上げの実測

| Claude 単体の弱点 | qult が補う機能 | 観測可能な効果 |
|---|---|---|
| プランがプロンプト止まりで session 終了で消失 | spec markdown を repo にコミット | 後続 session / レビュアーが当時の約束を読める |
| 曖昧な要件がスルーされる | 必須 `/qult:clarify` (5–10 問 × 最大 3 ラウンド) | design 着手前に Open Questions を解消 |
| 自己レビューの死角 | 独立 4 段レビュー | 作者が見逃したバグを捕捉 |
| spec 作成者の死角 | `spec-evaluator`（別コンテキスト、4 次元、threshold 18/17/16） | 欠落エッジケース / 曖昧 AC / scope drift を実装前に検出 |
| SAST を実行しない | Semgrep 統合 | OWASP Top 10 パターンを検出 |
| CVE データを知らない | osv-scanner 統合 | コミット前に脆弱な依存を発見 |
| パッケージ名の幻覚 | レジストリ確認 | typosquatting / 存在しないパッケージを阻止 |
| レビュー注意ドリフト | test-quality detector 常時発動 | empty test / trivial assertion を毎回検出 |
| 「Wave 2 を実装したコミットはどれ？」が当てずっぽう | wave-NN.md に commit range 記録 | `git log Range` で正確に把握 |

**qult が最強に効く場面:**
- spec が non-trivial な multi-Wave 機能
- 本番コード、5+ ファイル変更
- セキュリティ重要領域（認証、入力処理、暗号、外部 API）
- 依存変更を伴う作業（新規パッケージ、バージョン上げ）

**qult が overkill な場面:**
- 1 ファイル quick fix（typo, lockfile bump 等）
- 使い捨てプロトタイプ
- Spike / 実験
- → spec / レビューをスキップするだけ。hook がないので何もブロックしない。

## インストール

```bash
# Bun が必要: https://bun.sh
brew install semgrep         # 推奨 (security reviewer が利用)
brew install osv-scanner     # 推奨 (dep-vuln-check が利用)

/plugin marketplace add hir4ta/qult
/plugin install qult@qult
/qult:init                   # .qult/ を bootstrap + ~/.claude/rules/ に配布
```

`/qult:init` がプロジェクトに `.qult/` を作成（`specs/` と `config.json` は committed、`state/` は gitignored）。Workflow rules は `~/.claude/rules/qult-*.md` に配置されます。

プラグイン更新後は `/qult:update` で rules を refresh してください。

## ライフサイクル 30 秒

```bash
/qult:spec add-oauth "OAuth ログイン + リフレッシュトークン"
   → requirements.md → /qult:clarify (必須) → design.md → tasks.md
     各 phase に spec-evaluator gate (threshold 18/17/16)

/qult:wave-start                # HEAD を Wave 開始 commit として記録
…Wave 1 を実装…
/qult:wip "OAuth handler 雛形"  # → `[wave-01] wip: OAuth handler 雛形`
/qult:wip "tests"
/qult:wave-complete             # test + detector → commit → Range 記録

# 各 Wave で /qult:wave-start … /qult:wave-complete を繰り返す

/qult:review                    # spec 完了時の 4 段独立レビュー
/qult:finish                    # .qult/specs/add-oauth/ を archive へ移動 → merge/PR/hold/discard
```

## コマンド

| コマンド | 用途 |
|---|---|
| `/qult:init` | `.qult/` の bootstrap + workflow rules 配布（プロジェクトに 1 回） |
| `/qult:update` | rules refresh（プラグイン更新後） |
| `/qult:status` | 現状（active spec, pending fixes, tests, review）。`/qult:status archive` で過去 spec 一覧 |
| `/qult:spec` | 新規 spec 作成 — requirements → clarify → design → tasks |
| `/qult:clarify` | active spec の clarify を再実行（scope 変更時など） |
| `/qult:wave-start` | 次の未完了 Wave の start commit を記録 |
| `/qult:wave-complete` | test + detector + commit + Range 記録 |
| `/qult:wip` | Wave 中の `[wave-NN] wip: …` コミット |
| `/qult:review` | spec 完了時の 4 段独立レビュー |
| `/qult:finish` | spec を archive へ移動 + merge/PR/hold/discard |
| `/qult:debug` | 構造化された原因調査 |
| `/qult:skip` | detector の一時無効化 |
| `/qult:config` | `.qult/config.json` の閲覧 / 変更 |
| `/qult:doctor` | 健全性チェック（`.qult/` レイアウト、`.gitignore`、MCP、legacy 不存在） |
| `/qult:uninstall` | クリーンアンインストール |

## レビュアーモデル構成

| Agent | モデル | 理由 |
|---|---|---|
| spec-generator | sonnet | requirements / design / tasks の生成（phase 引数で切替） |
| spec-clarifier | **opus** | 5–10 問のクラリファイ生成 + 回答反映 |
| spec-evaluator | **opus** | 3 phase ゲート — spec が腐ると下流全部が腐る |
| spec-reviewer | sonnet | spec ↔ コードの機械的照合 |
| quality-reviewer | sonnet | 設計判断、高速 |
| **security-reviewer** | **opus** | 高リスク — **AI コードの 45% が脆弱**³ |
| **adversarial-reviewer** | **opus** | 最終番人 — エッジケース、サイレント障害 |

`.qult/config.json` の `review.models.*` キー、または `QULT_REVIEW_MODEL_*` 環境変数で上書き可能。

³ [Veracode GenAI Code Security](https://www.veracode.com/blog/genai-code-security-report/)

## 正直な限界

- **助言であって強制ではない**: `~/.claude/rules/qult-*.md` のルールはプロンプトレベルの誘導。研究（AgentPex）によれば **エージェントのトレースの 83% に少なくとも 1 件の手続き的違反** が含まれる。価値を引き出すには architect が能動的に skill を起動する必要がある（もしくは skip を受け入れる）。
- **レビューはトークンコストが重い**: `/qult:review` は 4 subagent が diff を読む。中規模変更で 40-100k トークン追加。qult はレビューを **spec 完了時のみ** 実行する（Wave 毎の自動レビューは行わない）ことでコストを抑えている。
- **Detector は TS 偏りのパターン/AST ベース**: security-check と test-quality-check は多言語基本対応だが、Python/Go/Rust は精度が落ちる。
- **シングルアーキテクト前提**: state 書き込みは atomic rename だがロックなし。複数 worktree で同一 `.qult/` を同時編集する用途はサポート外（必要なら repo を別途 clone）。
- **Claude Code 専用**: Cursor / Gemini CLI / Copilot からは現状利用不可。Markdown 自体は portable だが orchestration は Claude 固有の subagent に依存。

## アンインストール

```bash
/qult:uninstall                 # インタラクティブ: ~/.claude/rules/qult-*.md 削除、`.qult/` は任意
/plugin → qult を削除
```

## 哲学

```
qult は Claude の補助ツール、完璧なハーネスではない。
ハーネスエンジニアリング研究は設計の参考であって、設計そのものではない。
Markdown is the source of truth.
迷ったら軽い方を選ぶ。
Claude が単独でできない事だけ追加する。
```

## スタック

TypeScript / Bun 1.3+ / vitest / Biome / `.qult/state/*.json`（atomic-rename ファイル I/O、npm 依存ゼロ）
