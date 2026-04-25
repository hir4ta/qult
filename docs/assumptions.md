# Load-Bearing Assumptions

qult の各コンポーネントが依存する仮定と、仮定が崩れた場合の対処を記録する。

> "every component in a harness encodes an assumption about what the model can't do on its own, and those assumptions are worth stress testing."
> -- Anthropic, Harness Design for Long-Running Apps (2026-03-24)

## ストレステスト方針

モデルのメジャーアップデート時（Opus 5.0 等）に以下を検証する:

1. 各仮定について「モデル単体でこれを守れるか？」をテスト
2. 守れるなら該当コンポーネントを削除候補にする
3. 守れないなら仮定は維持。このドキュメントを更新する

主要なアーキテクチャ移行歴:
- **v0.14.0** (2026-03-27) — 19 機能削除、5 hooks + 8 state fields に簡素化
- **v1.0** (2026-04-25) — Hook 全廃、SQLite 全廃。markdown spec を single source of truth に、状態は `.qult/state/*.json` に file-based 化。

## State レイヤー

### Atomic write (write-to-temp + rename)

**仮定**: ファイル書き込み中の中断・クラッシュでファイルが破損しうる。

**根拠**: POSIX rename の原子性は OS 保証。`<file>.tmp` に書いて `rename(2)` する 2 段書きで torn read を回避。

**崩れたら**: この仮定は OS レベルなのでモデル進化では崩れない。削除不可。

### `.qult/state/*.json` を project-local の唯一の状態保管場所とする

**仮定**: 単一マシン・単一 architect 前提なら project-local ファイルで十分。global 設定 / cross-project 状態は不要。

**根拠**: v0.x の `~/.qult/qult.db` (SQLite) は global テーブル + cross-project 履歴を持っていたが、実運用ではほぼ project-local データのみ参照されていた。global config は未使用機能。

**崩れたら**: 複数 project 横断のメトリクス収集や、CI 上での履歴可視化が要件になれば cloud 同期 (`qult-cloud-plan.md` 参照) に格上げ。それ以外は project-local で十分。

**検証方法**: ユーザーが `~/.qult/` を作りたがるシグナル（issue / 機能要望）を観察。

### `.qult/specs/` の commit、`.qult/state/` の gitignore

**仮定**: spec markdown はチームと共有すべき真実。state はセッション局所。

**根拠**: spec はレビュアー / 後続セッションが読む。state は test_passed_at 等のローカルタイムスタンプで、commit してもノイズ。

**崩れたら**: チーム機能を作るなら state も部分的に共有可能（例: review_completed_at は共有、test_passed_at はローカル）。spec 共有は必須維持。

### 単一 architect 前提（並行 worktree 編集はサポート外）

**仮定**: 同じ `.qult/` を複数 worktree から同時に書くことはない。

**根拠**: 個人開発主体。チーム前提だとロック / etag CAS が必要になりコストが見合わない。

**崩れたら**: 並行性が必要になれば file-based mutex（`flock(2)` ベース）を導入。または cloud 同期で集中型ストレージ。

**検証方法**: 並行編集による missed update のレポートが上がるか観察。

## SDD パイプライン

### 必須 clarify ラウンド

**仮定**: Claude が初回に書く requirements には、architect が当たり前と思っている曖昧さが残る。

**根拠**: Spec Kit / tsumiki の経験則。曖昧な要件は下流の design / tasks の品質を毀損し、実装後に「想定と違う」を生む。

**崩れたら**: モデルが要件の曖昧さを自己検出して質問できるなら（現状でもある程度できる）、必須化を解除し opt-in に格下げ。

**検証方法**: clarify を skip した spec の design スコアが、必須化したものと有意差なくなれば仮定は弱まっている。

### spec-evaluator の 4 次元採点（threshold 18/17/16）

**仮定**: requirements / design / tasks のそれぞれが、独立した次元（Completeness / Testability / Unambiguity / Feasibility 等）で十分に評価可能。

**根拠**: 4 次元 × 5 段階 = 20 点満点で粒度が ergonomic（粗すぎず細かすぎず）。phase ごとに threshold を下げるのは「上流ほど重要」を反映。

**崩れたら**: 評価次元が増減する設計変更があれば本数値を更新。スコアが常に上限張り付きなら threshold を上げる。

**検証方法**: 実運用での phase ごとの score 分布を分析。中央値が threshold ± 1 を外れたら調整。

### temperature=0 + threshold ± 1 retry

**仮定**: LLM scoring には決定論性が必要。境界値での flap を 1 回 retry + 平均で抑制すれば実用十分。

**根拠**: temperature=0 でも完全決定論ではない（Anthropic API 仕様）が、threshold 直近のスコアを 2 回平均化すれば flap 確率が大きく下がる。

**崩れたら**: モデルが本当に決定論的になれば retry を削除。スコアが安定しないなら 3 サンプル median 等に拡張。

## Wave / コミット紐付け

### Wave 単位 = commit range（複数コミット可）

**仮定**: architect は Wave 中に WIP コミットを刻みたい。1 Wave 1 commit を強制すると編集体験が悪い。

**根拠**: 実装中の試行錯誤。range binding なら squash 不要、`git reset --soft` のリスクもない。

**崩れたら**: 1 commit per Wave を強制する強い理由（外部規約等）が出れば squash モードを追加。

**検証方法**: Wave あたり commit 数の分布を観察。常に 1 なら強制可、5+ なら現行が妥当。

### `[wave-NN]` prefix（2 桁ゼロパディング、上限 99）

**仮定**: prefix は `git log --grep` で検索でき、レビュアーが Wave 単位を識別できる。

**根拠**: regex `\[wave-(\d{2})\]` は単純で堅牢。99 Wave / spec は十分実用的（initial cap 6 + review-fix で延長余地）。

**崩れたら**: 100+ Wave に達する spec が出れば 3 桁化（`[wave-NNN]`）。だがそうなる前に spec を分割すべきサインなのでまず指針見直し。

### Range 整合性検証（rebase / reset --soft で stale 検出）

**仮定**: architect は Wave 完了後に rebase / reset --soft を行うことがあり、その場合古い Range の SHA は unreachable になる。

**根拠**: 個人開発で頻繁。検出して再記録 / 中断を促す方が、嘘の Range が wave-NN.md に残るより安全。

**崩れたら**: 履歴を git で改変しないチームなら検証は overhead。opt-out 可能な config を追加。

## Reviewer / Detector

### 独立 reviewer エージェント

**仮定**: Claude は自分の書いたコードを客観的に評価できない（confident leniency）。

**根拠**: Anthropic 記事が明示。複数研究（self-review は自己バグの 64.5% 見逃し）でも裏付け。

**崩れたら**: モデルが self-critique で人間並みに保守的になれば独立 reviewer を self-review に置換可能。だが訓練データレベルの問題なので近未来は崩れにくい。

**検証方法**: 同一 diff に対して self-review と独立 review のスコア差を計測。差が 1 点以内なら仮定は弱まっている。

### スコア閾値 30/40 (review)

**仮定**: aggregate < 30 のコードは改善余地がある。

**根拠**: 4 stage × 2 dimension = 8 次元 × 5 段階 = 40 点。30 = 全次元平均 3.75/5 ≈「各次元で minor issues あり」が合格ライン。`review.dimension_floor: 4` で各次元 4 未満を別途 block。

**崩れたら**: 実運用でスコア分布を計測し、閾値を調整。全レビューが上限近傍なら閾値を上げる。下限付近で停滞するなら下げる。

### 最大 3 イテレーション

**仮定**: 3 回の修正ループで改善が頭打ちになる。

**根拠**: Self-Refine 研究 (Madaan et al., 2023): 「3 回以上の反復は収穫逓減」。

**崩れたら**: 実運用で 3 回目の改善幅が 0-1 点なら 2 回に削減検討。

### Detector severity ベースの commit block

**仮定**: detector が `severity ∈ {high, critical}` を返したら、commit を block するのが正しい。

**根拠**: Tier 1 detector は false positive を抑えるよう設計されている（security-check の Semgrep ルール、osv-scanner の CVE データ等は外部知識ベース）。

**崩れたら**: false positive 率が上がれば severity 判定の signed rule set 等が必要。現状は user-supplied detector の信頼性を out-of-scope と明記。

**検証方法**: `clear_pending_fixes` の reason を分析。「false positive」が多発したら detector ロジック見直し。

## Review Requirement

### 5 ファイル閾値

**仮定**: 5 ファイル以上のゲート対象変更は十分に大きく、独立レビューの価値がある。

**根拠**: 経験的な閾値。厳密な根拠はない。

**崩れたら**: 運用データで要調整。

**注意**: この閾値は最も仮定が弱い。運用データ収集を優先すべき。

### Spec 完了時のみの自動 review（Wave 単位は手動）

**仮定**: Wave 単位で自動 review すると token コストが過大。spec 全体の整合性を見るには spec 完了時 1 回で十分。

**根拠**: `/qult:review` は 40-100k トークン消費。Wave が 6 個ある spec で毎 Wave review すると数十万トークン。spec-evaluator が phase ごとに走っているので、コード review は最後で良い。

**崩れたら**: Wave が破壊的（前 Wave の前提を覆す）ようなパターンが頻発するなら Wave 単位の最低限 review が必要。Wave 設計を見直す方が先。

## Calibration Rationale

各閾値の設計根拠を集約する。キャリブレーションデータの蓄積に伴い更新すること。

### review.score_threshold: 30/40 (+ dimension_floor 4)

- 4 stage (Spec / Quality / Security / Adversarial) × 2 dimension = 8 次元 × 5 段階、満点 40
- 30 = 全次元平均 3.75/5 — 各次元で minor issues が 1 件許容されるライン
- 加えて `review.dimension_floor` (default 4) で各次元 4 未満が 1 つでもあれば block（平均に埋もれた低スコア次元を拾う）

### spec_eval.thresholds.{requirements: 18, design: 17, tasks: 16}

- 各 phase 4 次元 × 5 段階 = 20 点満点
- requirements 18: 上流 spec の品質 = 下流全体の上限。最も厳しく
- design 17: requirements を満たす設計が複数あり得るぶん許容幅を取る
- tasks 16: Wave / task の組み立ては実装中に微調整しうる
- 各 phase で `dimension_floor: 4` を併用（floor 4 と total 18 の両方を満たす必要）

### review.required_changed_files: 5

- ゲート対象ファイル 5 以上でレビュー必須
- 根拠: 5 ファイル以上の変更ではファイル間相互作用の見落としが増加する経験則
- 厳密なデータなし — 最も仮定が弱い閾値。運用データで要調整

### review.max_iterations: 3 / spec_eval.iteration_limit: 3

- Self-Refine (Madaan et al., 2023) の知見: 3 回以上の反復は収穫逓減
- 両方 3 回（review はコード、spec_eval は markdown）
- 実運用で 3 回目の改善幅が 0-1 点なら 2 回に削減検討
