# Requirements: レビュー品質強化 + ナレッジ品質ゲート

## Goal

alfredのレビュー品質を強化し、ナレッジの保存品質を担保する。code-reviewerのトリアージ強化、fix検証の分離、レビューキャリブレーション、ナレッジ保存時品質ゲートの4機能を実装する。

## Success Criteria

- [ ] SC-1: code-reviewerプロンプトにスコープフィルタ指示が含まれ、Phase 1でhunk範囲が抽出される
- [ ] SC-2: fix_mode再レビュー時に前回findingsが`.alfred/.state/review-findings-{slug}.json`から読み込まれ、プロンプトに含まれる
- [ ] SC-3: ナレッジ保存時にセマンティック重複（>= 0.90でnear_duplicate警告、>= 0.85でsimilar_existing一覧）が返される
- [ ] SC-4: ナレッジ保存時にアクショナビリティ警告（行動指示語・条件対なし）が返される
- [ ] SC-5: レビューfindingsがreview-findingタグ付きpatternとして保存され、ledger verifyでoutcome記録可能
- [ ] SC-6: 既存テストが全てパスし、新機能のユニットテストが追加される

## Functional Requirements

### FR-1: レビュートリアージ — スコープフィルタ
<!-- confidence: 8 | source: code | grounding: reviewed -->

WHEN code-reviewer がサブレビューアーのfindingsを集約する際、the system SHALL Phase 1で`git diff --unified=0`のhunk範囲を`{file: string, ranges: [start, end][]}` 形式で抽出し、各findingのfile:lineがhunk範囲内かを照合する。diff外の既存コードへの指摘はINFOに降格する。

diff base: Wave開始時のコミット（attend の initial_commit、または `git merge-base HEAD main`）。

実装レイヤー: code-reviewer.md の Phase 1 で bash `git diff --unified=0 | grep '^@@'` を実行し、結果をPhase 3の集約判断材料として渡す。

**AC-1.1**: Given diff が src/mcp/ledger.ts:100-150 を含む、When finding が src/mcp/ledger.ts:50 を指摘する、Then severity は INFO に降格される
**AC-1.2**: Given diff が src/mcp/ledger.ts:100-150 を含む、When finding が src/mcp/ledger.ts:120 を指摘する、Then severity は元のまま維持される

### FR-2: レビュートリアージ — オシレーション検出
<!-- confidence: 7 | source: inference | grounding: inferred -->

WHEN fix_mode中の再レビューでfindingsを集約する際、the system SHALL `.alfred/.state/review-findings-{slug}.json` から前回findingsを読み込み、今回findingsと比較する。同一finding（file:line + category一致）が前回のfixで解消された後に再度指摘されている場合（A→B→Aパターン）をオシレーションとして検出し、前回のfix方向をdirectiveとして固定する。

前回findings永続化: code-reviewer実行後、findings配列（file:line, severity, category, 1行要約）を `.alfred/.state/review-findings-{slug}.json` に書き出す。attend SKILL.md のWave完了フローに組み込む。

finding同一性: `file:line + category` の一致で判定。LLMの表現揺れは category レベルで吸収。

脱出条件: 3回連続でオシレーションが検出された場合、ユーザーに判断を委ねる（AskUserQuestion）。

**AC-2.1**: Given 前回 "関数Xをinline化すべき [DESIGN]" → fix でinline化 → 今回 "関数Xを抽出すべき [DESIGN]"（同file:line）、Then オシレーション警告が出力される
**AC-2.2**: Given 前回と今回で異なるfile:lineの指摘、Then オシレーションとして検出されない

### FR-3: レビュートリアージ — severity再分類
<!-- confidence: 7 | source: design | grounding: inferred -->

WHEN code-reviewer がfindingsを集約する際、the system SHALL 以下の機械的照合可能な基準でseverity を再分類する:
- Out of Scopeに明記された項目への指摘: → INFO
- active spec の recorded decisions（ledger decision）に記録済みのトレードオフの再指摘: → INFO
- CLAUDE.md の Rules セクションに明記された設計判断と整合する finding: → INFO

Phase 1で `dossier status` に加え、active spec の decisions セクションと CLAUDE.md Rules を読み、「トレードオフ済み事項リスト」を構築する。

**AC-3.1**: Given recorded decision "パフォーマンスよりシンプルさを優先" が存在、When "N+1クエリパターン" が指摘される、Then severity は INFO に降格される

### FR-4: Fix検証 — バリデーション指示強化
<!-- confidence: 8 | source: design | grounding: reviewed -->

WHEN fix_mode後の再レビューを実行する際、the system SHALL 以下のバリデーション観点を再レビュープロンプトに明示的に含める:
1. 修正が根本原因に対処しているか（バンドエイド修正でないか）
2. 修正が新たな問題を導入していないか
3. 前回のfindingsが実際に解消されているか（前回findings一覧とのdiff-on-diff）

**AC-4.1**: Given fix_mode で修正が行われた、When 再レビューが実行される、Then レビュープロンプトに「Previous Findings」セクションと「Validation Criteria」セクションが含まれる

### FR-5: Fix検証 — 前回findings入力
<!-- confidence: 8 | source: code | grounding: reviewed -->

WHEN fix_mode中の再レビューを実行する際、the system SHALL `.alfred/.state/review-findings-{slug}.json` から前回findingsを読み込み、構造化データとして再レビューのコンテキストに含める。

永続化フォーマット:
```json
{
  "slug": "task-slug",
  "wave": 1,
  "reviewed_at": "ISO8601",
  "findings": [
    { "file": "src/foo.ts", "line": 10, "severity": "critical", "category": "security", "summary": "SQL injection via unsanitized input" }
  ]
}
```

**AC-5.1**: Given 前回 "CRITICAL: src/foo.ts:10 — SQL injection" が検出された、When 再レビューが実行される、Then プロンプトに前回findingsがJSON形式で含まれる

### FR-6: ナレッジ品質ゲート — セマンティック重複検出
<!-- confidence: 9 | source: code | grounding: verified -->

WHEN ledger save が実行される際、IF VOYAGE_API_KEY が設定されている場合、the system SHALL 保存内容のembeddingを計算し（`emb.embedForStorage()` を await）、そのベクトルで既存ナレッジを `vectorSearch` 検索して以下の結果をレスポンスに含める:
- 類似度 >= 0.90: `quality_warnings` に "near_duplicate" 警告 + 既存エントリ情報
- 類似度 >= 0.85: `similar_existing` に類似エントリ一覧（上位3件）
- 保存自体はBLOCKしない（WARNINGのみ）

embedding再利用: 重複チェックに使ったベクトルをそのまま `insertEmbedding` に渡す（2回計算しない）。

**AC-6.1**: Given 既存ナレッジ "hook timeoutは5秒" が存在、When "hookのタイムアウトは5秒に設定" を保存する（類似度 >= 0.90）、Then quality_warnings に near_duplicate が含まれる
**AC-6.2**: Given VOYAGE_API_KEY が未設定、When ledger save が実行される、Then 重複チェックはスキップされ、quality_warnings は空

### FR-7: ナレッジ品質ゲート — アクショナビリティ評価
<!-- confidence: 7 | source: inference | grounding: inferred -->

WHEN ledger save が実行される際、the system SHALL 保存内容のアクショナビリティを形式チェック（LLM判定ではない）し、低スコアの場合に `quality_warnings` に "low_actionability" 警告を含める。

sub_type別判定基準:
- **decision**: reasoning フィールドに具体的根拠語が含まれるか
- **pattern**: pattern フィールドに解決策語（「解決」「対策」「solution」「fix」等）が含まれるか
- **rule**: text フィールドに行動指示語が含まれるか

行動指示語リスト（日英対応、`ACTIONABILITY_PATTERNS` として定義）:
- 肯定: 「使う」「使用する」「推奨」「必須」「〜こと」「use」「must」「should」「prefer」「require」
- 否定: 「しない」「避ける」「禁止」「avoid」「never」「don't」
- 条件: 「場合は」「ときは」「のとき」「when」「if」「while」

上記いずれにも該当しない場合: `quality_warnings` に "low_actionability" 警告。

**AC-7.1**: Given title="TypeScriptはJSのスーパーセットである"、pattern="TypeScriptの特徴"、When pattern として保存する、Then low_actionability 警告が返される
**AC-7.2**: Given title="テストではモックDBではなく実DBを使用する"、text="テストでは常に実DBを使用すること"、When rule として保存する、Then low_actionability 警告は返されない

### FR-8: ナレッジ品質ゲート — 矛盾検出
<!-- confidence: 7 | source: code | grounding: inferred -->

WHEN ledger save が実行される際、IF VOYAGE_API_KEY が設定されている場合、the system SHALL FR-6の重複チェック結果のうち類似度 >= 0.85 のエントリに対して既存の `classifyConflict` を実行し、"potential_contradiction" と判定された場合に `quality_warnings` に警告を含める。

2層構成:
- 類似度 >= 0.85 かつ contradiction: `quality_warnings` に "potential_contradiction" + 既存エントリ情報
- 類似度 >= 0.70 かつ contradiction: `similar_existing` に "possible_conflict" ラベル（参考情報のみ）

低類似度での矛盾検出は偽陽性が多いため、0.85以上を前提条件とする。

**AC-8.1**: Given 既存ルール "テストでは常に実DBを使用"（類似度 0.88）、When "テストではモックDBを推奨" を保存する、Then quality_warnings に potential_contradiction が含まれる

### FR-9: レビューキャリブレーション — finding追跡
<!-- confidence: 8 | source: code | grounding: reviewed -->

WHEN extractReviewFindings でレビューfindingが保存される際、the system SHALL knowledge_index に sub_type="pattern" として保存し、tags に "review-finding" を付与する。pattern フィールドに severity, category, file:line のメタデータを含める。

永続化先: 既存の knowledge_index テーブル（sub_type="pattern", status="draft"）。DBスキーマ変更不要。review-finding タグで通常のpatternと区別可能。

**AC-9.1**: Given code-reviewer が "CRITICAL: src/foo.ts:10 — SQL injection" を検出、When finding が保存される、Then tags に "review-finding" が含まれ、pattern に severity と file:line が含まれる

### FR-10: レビューキャリブレーション — outcome記録
<!-- confidence: 7 | source: inference | grounding: inferred -->

WHEN ledger verify が review-finding タグを持つエントリに対して実行される際、the system SHALL outcome パラメータ（confirmed/rejected）を受け付ける。

- outcome=confirmed: status を "approved" に更新（true positive）
- outcome=rejected: status を "rejected" に更新（false positive）、enabled を 0 に設定
- review-finding タグを持たないエントリに outcome が渡された場合: 無視し、通常の verify 動作を実行（後方互換性）

**AC-10.1**: Given review-finding タグを持つ draft pattern が存在、When ledger verify id=X outcome=rejected が実行される、Then status が "rejected"、enabled が 0 に更新される
**AC-10.2**: Given 通常の pattern（review-finding タグなし）、When ledger verify id=X outcome=confirmed が実行される、Then outcome は無視され、通常の verification_due 更新のみ実行される

## Non-Functional Requirements

### NFR-1: 保存レイテンシ
<!-- confidence: 7 | source: inference | grounding: inferred -->

品質ゲート処理（FR-6〜FR-8）を含むledger save全体のレスポンス時間は5秒以内であること。Voyage API呼び出し（通常300-500ms）は重複チェック用に1回だけ実行し、タイムアウト時（3秒）はチェックをスキップして保存を続行する。

### NFR-2: Voyage API未設定時のフォールバック
<!-- confidence: 9 | source: code | grounding: verified -->

VOYAGE_API_KEY 未設定時の動作:
- FR-6（セマンティック重複検出）: スキップ、quality_warnings に含めない
- FR-7（アクショナビリティ評価）: API不要のため常に実行
- FR-8（矛盾検出）: スキップ、quality_warnings に含めない
- エラーにならず、保存は正常に完了する

### NFR-3: 後方互換性
<!-- confidence: 9 | source: code | grounding: verified -->

- ledger save のレスポンスに `quality_warnings` と `similar_existing` フィールドを追加するが、既存フィールド（status, id, entry_id, title, file_path, embedding_status）は変更しない
- ledger verify に `outcome` パラメータを追加するが、パラメータ未指定時は既存動作（Leitner検証）を維持
- review-finding タグなしエントリへの outcome 指定は無視

### NFR-4: プロンプト改修の独立性
<!-- confidence: 8 | source: design | grounding: reviewed -->

code-reviewer.md と attend SKILL.md のプロンプト改修は、TypeScriptコードの変更と独立して適用可能であること。FR-1〜5のプロンプト改修はcode-reviewer.mdとattend SKILL.mdの修正のみで機能し、TypeScriptコード変更は FR-6〜10 のナレッジ品質ゲート/キャリブレーション機能のみ。

## Out of Scope

- LLMによるナレッジ保存可否の自動判定（self-bias問題）
- ナレッジの自動マージ・自動物理削除
- ダッシュボード（Web UI）でのナレッジ品質可視化
- inspect / brief / mend スキルのレビュー改修（code-reviewerのみ対象）
- DBスキーマ変更（既存 knowledge_index の sub_type + tags + status + enabled で表現）
- extractReviewFindings の抽出精度改善（将来課題: 構造化JSON出力）
