# Research: レビュー品質強化 + ナレッジ品質ゲート

## 1. 現状分析

### 1.1 code-reviewer エージェント (plugin/agents/code-reviewer.md)
- 3サブレビューアー（security, logic, design）を並列実行 → Phase 3 で集約
- 集約: 重複排除 + 偽陽性除外 + severity順 + 上限15件
- **Gap**: 集約ロジックはオーケストレーターの判断に依存。構造的なトリアージ基準がない
- **Gap**: スコープフィルタ（変更diff外の既存コードへの指摘を除外）なし
- **Gap**: オシレーション検出なし

### 1.2 Fix検証 (attend/SKILL.md)
- Wave完了時: code-reviewer → Critical見つかる → fix_mode → 再レビュー → gate clear
- **Gap**: 再レビューは同じcode-reviewerで行う。fix が根本原因に対処しているかの独立検証なし
- **Gap**: re_reviewed検出が正規表現ベース（`/\bfinding\b/i` 等）で脆弱

### 1.3 ナレッジ保存 (src/mcp/ledger.ts)
- validateKnowledgeFields: JSON混入検出, title長(200), 空白チェック
- **Gap**: 保存前のセマンティック重複チェックなし（detectKnowledgeConflictsは存在するが統合されていない）
- **Gap**: アクショナビリティ評価なし
- **Gap**: 矛盾検出が保存フローに組み込まれていない

### 1.4 レビュー知識抽出 (src/mcp/knowledge-extractor.ts)
- extractReviewFindings: CRITICAL/HIGH行を3件まで抽出 → draft status で自動保存
- **Gap**: 抽出品質が低い（行ベースの正規表現マッチ、コンテキスト3行のみ）
- **Gap**: true positive / false positive の追跡なし

### 1.5 重複検出 (src/store/fts.ts)
- detectKnowledgeConflicts: pairwise cosine >= 0.70
- classifyConflict: キーワード極性ペア（always/never等）
- **Gap**: バッチ処理のみ、save時のリアルタイム検出なし

## 2. 外部リサーチ知見

### 2.1 Mem0 (AIメモリ管理)
- embedding類似度 0.85以上でマージトリガー、0.90以上で重複排除
- ストレージ60%削減、検索精度22%向上
- LLMベースのADD/UPDATE/DELETE/NONE判定

### 2.2 学術論文 (arXiv:2601.21116)
- アーキテクチャ決定の20-25%が2ヶ月以内にエビデンス陳腐化
- Epistemic Layer: 未検証仮説と実証済み主張の分離
- Conservative Assurance Aggregation: 弱いエビデンスによる信頼度膨張防止

### 2.3 Zenn記事（ハーネスエンジニアリングでコードレビュー自動化）
- 5ステップ自動レビューループ: レビュー → トリアージ → 修正 → バリデーション → コミット
- トリアージ: severity分類 + オシレーション検出（A→B→Aパターン） + スコープ判定
- バリデーション: 別モデル/別セッションで根本原因対処を検証

### 2.4 Self-bias問題 (NYU研究, IBM Research)
- LLMは自分が生成した回答を高く評価する傾向
- ナレッジ保存可否をLLMに完全委任するのは危険
- 構造的チェック（自動化可能）+ 事後評価（利用実績ベース）の二層が安全

## 3. 実装オプション分析

### 3.1 レビュートリアージ

**Option A: 独立トリアージエージェント追加**
- code-reviewer.md の Phase 3 前に専用エージェントを追加
- 利点: 独立した判断、スコープフィルタ、オシレーション検出
- リスク: エージェント数増加（3→4）、レイテンシ増
- 工数: M

**Option B: Phase 3 集約プロンプト強化** ← 推奨
- 既存の集約フェーズに構造的トリアージ基準を明示
- スコープフィルタ: diff hunk範囲外の指摘をINFOに降格
- オシレーション検出: 過去findingsとの比較指示を追加
- 利点: エージェント数据え置き、既存フロー互換
- リスク: オーケストレーターの判断品質に依存
- 工数: S

**選択: Option B** — エージェント追加のオーバーヘッドを避け、既存集約フェーズを強化。効果不十分なら後からOption Aに移行可能。

### 3.2 Fix検証分離

**Option A: 別エージェント (validation agent)**
- fix後にcode-reviewerとは別のプロンプトでバリデーション
- 利点: 独立視点、バンドエイド検出
- リスク: ターン数増加
- 工数: M

**Option B: code-reviewer再実行 + バリデーション指示追加** ← 推奨
- 再レビュー時に「前回findingsの解消確認」を明示的に指示
- diff-on-diff: 前回レビュー時のdiffと今のdiffの差分を入力に含める
- 利点: 既存フロー互換、エージェント追加なし
- リスク: same-model-bias
- 工数: S

**選択: Option B** — attend SKILL.md のfix_mode再レビュー指示を強化。バリデーション観点（根本原因対処、バンドエイド検出、新規問題導入）を明示。

### 3.3 レビューキャリブレーション

**Option A: DB拡張 (review_findings テーブル)**
- finding毎にDB行を持ち、outcome(true_positive/false_positive/unknown)を記録
- 利点: 精密な追跡、カテゴリ別精度統計
- リスク: スキーマ変更、DB マイグレーション
- 工数: L

**Option B: ledger save + tag ベース** ← 推奨
- review findingをpatternとして保存時に `review-finding` タグ付与
- outcome は ledger verify で confirmed / rejected のフラグ
- 利点: 既存スキーマ活用、追加テーブル不要
- リスク: 粒度が粗い
- 工数: S

**選択: Option B** — 既存のledger save + verify基盤を活用。KnowledgeRow に新カラムは不要。review-findingタグで集計。

### 3.4 ナレッジ品質ゲート

**Option A: ledger save 内にインライン品質チェック** ← 推奨
- 保存前に: (1) セマンティック重複 (2) アクショナビリティ (3) 矛盾検出
- レスポンスに warnings + similar_existing を返す（保存は続行、BLOCKしない）
- 利点: 既存フロー互換、LLMが判断材料を得られる
- リスク: Voyage API呼び出しで保存レイテンシ増（非同期化で軽減）
- 工数: M

**Option B: 保存後バッチ品質チェック**
- reflect アクションを拡張して品質レポート
- 利点: 保存フロー変更なし
- リスク: 低品質ナレッジが一旦保存される
- 工数: S

**選択: Option A** — 保存時にリアルタイム警告を返す方がLLMの判断を助ける。WARNING（保存はする）でBLOCKはしない。

## 4. リスクと制約

<!-- confidence: 8 | source: code -->

- **Voyage API依存**: セマンティック重複チェックにはembeddingが必要。VOYAGE_API_KEY未設定時はFTS5フォールバック
- **保存レイテンシ**: 品質チェック追加で ledger save が遅くなる可能性 → embedding部分は非同期で軽減
- **プロンプト改修の効果測定**: トリアージ強化の効果は定量的に測定困難 → キャリブレーション機能で間接的に測定
- **既存テストへの影響**: ledger save のレスポンス構造変更 → 既存テスト修正が必要
