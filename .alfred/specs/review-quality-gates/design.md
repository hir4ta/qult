# Design: レビュー品質強化 + ナレッジ品質ゲート

## Architecture Overview

4機能を2つの実装レイヤーに分離:

| レイヤー | 機能 | 変更対象 |
|---------|------|---------|
| プロンプト改修 | FR-1〜5 トリアージ + Fix検証 | plugin/agents/code-reviewer.md, plugin/skills/attend/SKILL.md |
| コード改修 | FR-6〜10 品質ゲート + キャリブレーション | src/mcp/ledger.ts, src/mcp/quality-gate.ts (新規), src/mcp/knowledge-extractor.ts |

```
┌─────────────────────────────────────────────┐
│ code-reviewer.md (プロンプト改修)              │
│                                             │
│  Phase 1: Context Gathering                 │
│    + git diff --unified=0 → hunk範囲抽出     │  ← FR-1
│    + decisions/CLAUDE.md → トレードオフリスト   │  ← FR-3
│                                             │
│  Phase 2: Parallel Review (3 agents, 変更なし)│
│                                             │
│  Phase 3: Aggregation (トリアージ強化)        │
│    + スコープフィルタ (hunk範囲外 → INFO)      │  ← FR-1
│    + severity再分類 (トレードオフ済み → INFO)   │  ← FR-3
│    + 構造化findings出力 (JSON format)         │  ← FR-5
│                                             │
│  ※ findings永続化はcode-reviewerではなく       │
│    呼び出し元 (attend) がWriteで実行           │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ attend SKILL.md (プロンプト改修)              │
│                                             │
│  Wave完了時:                                │
│    1. code-reviewer agent spawn (foreground) │
│    2. findings出力をパース                    │
│    3. review-findings-{slug}.json に Write   │  ← FR-5 永続化
│    4. fix_mode時: 前回findings読み込み        │  ← FR-2, FR-5
│    5. オシレーション検出 (構造比較)            │  ← FR-2
│    6. re-review プロンプトに前回findings含む   │  ← FR-4
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ quality-gate.ts (新規モジュール)              │
│                                             │
│  qualityGate()                              │
│    1. actionabilityCheck (常に実行, API不要)  │  ← FR-7
│    2. FTS5粗フィルタ (タイトル完全一致検出)     │  ← FR-6 前段
│    3. IF 粗フィルタhit OR emb利用可:          │
│       await embedding → vectorSearch          │  ← FR-6
│       → duplicateCheck (>= 0.90)             │
│       → contradictionCheck (>= 0.85)         │  ← FR-8
│    4. 結果: QualityGateResult                │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ledger.ts (コード改修)                       │
│                                             │
│  ledgerSave()                               │
│    ... 既存バリデーション + entry構築 ...       │
│    ★ qualityGate() 呼び出し                  │
│    ... writeKnowledgeFile + upsert ...        │
│    ... insertEmbedding (ベクトル再利用) ...    │
│    レスポンス + quality_warnings              │
│                                             │
│  ledgerVerify()                             │
│    + outcome パラメータ (review-finding用)    │  ← FR-10
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ knowledge-extractor.ts (コード改修)          │
│                                             │
│  extractReviewFindings()                     │
│    + tags に "review-finding" 追加           │  ← FR-9
│    + status="draft" のまま (検索除外)         │  ← H-4対応
└─────────────────────────────────────────────┘
```

## Component Design

### Component 1: code-reviewer トリアージ強化 (FR-1, FR-3)

**変更ファイル**: `plugin/agents/code-reviewer.md`

#### Phase 1 追加ステップ

```markdown
5. Run `git diff --unified=0` and extract hunk ranges:
   Format: file → [start_line, end_line] pairs
   This defines the "in-scope" zone for findings.
6. Read active spec decisions + CLAUDE.md Rules to build "settled decisions" list
```

#### Phase 3 トリアージ追加

```markdown
6. **Scope filter**: For each finding with file:line, check if the line falls within
   a diff hunk range from Step 5. If NOT in any hunk → downgrade to Info with note
   "[SCOPE] Not in current diff — pre-existing issue"
7. **Decision filter**: For each finding, check if it re-raises a recorded trade-off.
   If so → downgrade to Info: "[DECIDED] Already decided: {decision title}"
```

#### Phase 3 出力: 構造化 findings

findings永続化はcode-reviewerではなく呼び出し元(attend)が行う（code-reviewerはdisallowedTools: Write,Edit）。code-reviewerは最後にfindings JSONブロックを出力する:

```markdown
### Structured Findings (for orchestrator use)
At the end of your review, output findings in this JSON format within a code block:

\`\`\`json
{"findings": [{"file":"src/foo.ts","line":10,"severity":"critical","category":"security","summary":"SQL injection"}]}
\`\`\`
```

### Component 2: findings永続化 + オシレーション検出 + Fix検証 (FR-2, FR-4, FR-5)

**変更ファイル**: `plugin/skills/attend/SKILL.md`

#### attend Wave完了フロー（改修）

```
1. Git commit
2. code-reviewer agent spawn (foreground)
3. Parse structured findings JSON from agent output
4. Write findings to .alfred/.state/review-findings-{slug}.json
5. IF fix_mode re-review:
   a. Read previous findings from review-findings-{slug}.json
   b. Oscillation detection (structural):
      - For each current finding, compute findingId = hash(file + ":" + line + ":" + category)
      - Compare with previous findingIds
      - If a findingId was present → fixed → present again: OSCILLATION
      - Lock previous fix direction as directive
      - After 3 consecutive oscillations on same findingId: AskUserQuestion
   c. Include "Previous Findings" + "Validation Criteria" in re-review prompt
6. dossier gate / ledger save (既存)
```

#### findings永続化フォーマット（変更なし）

```json
{
  "slug": "review-quality-gates",
  "wave": 1,
  "reviewed_at": "2026-03-25T12:00:00Z",
  "findings": [
    { "file": "src/mcp/ledger.ts", "line": 120, "severity": "critical", "category": "security", "summary": "SQL injection via unsanitized input", "id": "a1b2c3" }
  ]
}
```

ライフサイクル: Wave ごとに上書き（`wave` フィールドで識別）。`dossier action=complete` 時に .state/ ディレクトリから自動削除（既存の state cleanup）。

#### Re-review プロンプトテンプレート

attend SKILL.md のWave完了セクションに追加:

```markdown
When re-reviewing after fixes, provide code-reviewer with:

#### Previous Findings
<paste findings from review-findings-{slug}.json>

#### Validation Criteria
For EACH previous finding, verify:
1. Root cause addressed? (not just symptom)
2. No new issues introduced?
3. Actually resolved? (file:line check)

Report: "N of M previous findings resolved. N unresolved. N new findings."
```

### Component 3: ナレッジ品質ゲート (FR-6, FR-7, FR-8)

**変更ファイル**: `src/mcp/quality-gate.ts` (新規), `src/mcp/ledger.ts`

#### qualityGate 関数

独立モジュール `src/mcp/quality-gate.ts` に切り出し。

```typescript
interface QualityGateResult {
  warnings: QualityWarning[];
  similarExisting: SimilarEntry[];
  embedding: number[] | null;
}

interface QualityWarning {
  type: "near_duplicate" | "low_actionability" | "potential_contradiction";
  message: string;
  related?: { id: number; title: string; similarity?: number };
}

interface SimilarEntry {
  id: number;
  title: string;
  similarity: number;
  label?: "possible_conflict";
}

export async function qualityGate(
  store: Store,
  emb: Embedder | null,
  entryText: string,    // buildEmbeddingText() の結果
  entryContent: string, // JSON.stringify(entry) — classifyConflict用
  subType: string,
  params: LedgerParams, // actionability判定用
): Promise<QualityGateResult> {
  const warnings: QualityWarning[] = [];
  const similarExisting: SimilarEntry[] = [];
  let embedding: number[] | null = null;

  // FR-7: アクショナビリティ (API不要、常に実行)
  const actionWarning = checkActionability(params, subType);
  if (actionWarning) warnings.push(actionWarning);

  // FR-6 前段: FTS5粗フィルタ (タイトル完全一致)
  const title = params.title ?? "";
  let hasFTSCandidate = false;
  if (title.length >= 5) {
    const ftsHits = searchKnowledgeFTS(store, title, 3);
    hasFTSCandidate = ftsHits.length > 0;
  }

  // FR-6 + FR-8: セマンティック重複 + 矛盾 (粗フィルタhit OR emb利用可)
  if (emb && (hasFTSCandidate || true)) {
    // 常にembedding取得（insertEmbedding再利用のため）
    try {
      embedding = await Promise.race([
        emb.embedForStorage(entryText),
        rejectAfter(3000), // 3秒タイムアウト
      ]) as number[];

      if (embedding) {
        const { vectorSearchKnowledge } = await import("../store/vectors.js");
        const matches = vectorSearchKnowledge(store, embedding, 15, 0.70);
        // ↑ limit=15, minScore=0.70 で十分な候補を取得

        for (const match of matches) {
          const doc = getKnowledgeByID(store, match.sourceId);
          if (!doc || !doc.enabled) continue;

          if (match.score >= 0.90) {
            warnings.push({
              type: "near_duplicate",
              message: `類似度 ${(match.score * 100).toFixed(0)}% の既存ナレッジあり`,
              related: { id: doc.id, title: doc.title, similarity: match.score },
            });
          }

          if (match.score >= 0.85) {
            const conflictType = classifyConflict(entryContent, doc.content);
            const entry: SimilarEntry = { id: doc.id, title: doc.title, similarity: match.score };
            if (conflictType === "potential_contradiction") {
              warnings.push({
                type: "potential_contradiction",
                message: `既存ナレッジ "${doc.title}" と矛盾の可能性`,
                related: { id: doc.id, title: doc.title, similarity: match.score },
              });
            }
            similarExisting.push(entry);
          } else if (match.score >= 0.70) {
            const conflictType = classifyConflict(entryContent, doc.content);
            similarExisting.push({
              id: doc.id, title: doc.title, similarity: match.score,
              ...(conflictType === "potential_contradiction"
                ? { label: "possible_conflict" as const } : {}),
            });
          }
        }
      }
    } catch {
      // タイムアウトまたはAPI失敗: チェックスキップ、保存続行
      // embedding = null → ledgerSave で既存の非同期フォールバック
    }
  }

  return { warnings, similarExisting, embedding };
}
```

**設計判断**:
- `vectorSearchKnowledge` に `minScore` パラメータを追加（既存のMIN_SIMILARITY=0.6をオーバーライド可能に）、limit=15で十分な候補取得
- `classifyConflict` には `entryContent`（構築済みentryのJSON）を渡す（paramsのstringifyではない）
- FTS5粗フィルタはembedding取得を省略する目的ではなく、embedding再利用のため常にawait。タイムアウト時のみスキップ

#### checkActionability 関数

```typescript
const ACTIONABILITY_PATTERNS = {
  positive: [
    /使う|使用する|採用|推奨|必須|すること|すべき|統一|設定|指定|選択|移行/,
    /\b(use|must|should|prefer|require|adopt|implement|configure|set)\b/i,
  ],
  negative: [
    /しない|避ける|禁止|不要|削除/,
    /\b(avoid|never|don't|do not|prohibit|forbid|remove|disable)\b/i,
  ],
  conditional: [
    /場合は|ときは|のとき|場合/,
    /\b(when|if|while|where|unless)\b/i,
  ],
};
```

sub_type別判定対象:
- decision: title + reasoning
- pattern: title + pattern
- rule: title + text

#### ledgerSave 統合

```typescript
async function ledgerSave(store, emb, params) {
  // ... 既存バリデーション + entry構築 ...

  const embText = buildEmbeddingText(subType, params);
  const entryContent = JSON.stringify(entry);

  // ★ 品質ゲート
  const gate = await qualityGate(store, emb, embText, entryContent, subType, params);

  // ... writeKnowledgeFile + upsertKnowledge (既存) ...

  // embedding再利用
  let embeddingStatus = "none";
  if (emb && changed) {
    if (gate.embedding) {
      const { insertEmbedding } = await import("../store/vectors.js");
      insertEmbedding(store, "knowledge", dbId, emb.model, gate.embedding);
      embeddingStatus = "saved";
    } else {
      // タイムアウト時: 既存の非同期フォールバック
      emb.embedForStorage(embText)
        .then(async (vec) => {
          const { insertEmbedding } = await import("../store/vectors.js");
          insertEmbedding(store, "knowledge", dbId, emb.model, vec);
        }).catch(err => console.error(`embedding failed: ${err}`));
      embeddingStatus = "pending";
    }
  }

  return jsonResult({
    status: changed ? "saved" : "unchanged (duplicate)",
    id: dbId, entry_id: id, title: params.title,
    file_path: filePath, embedding_status: embeddingStatus, lang,
    ...(gate.warnings.length > 0 ? { quality_warnings: gate.warnings } : {}),
    ...(gate.similarExisting.length > 0 ? { similar_existing: gate.similarExisting } : {}),
  });
}
```

### Component 4: レビューキャリブレーション (FR-9, FR-10)

**変更ファイル**: `src/mcp/knowledge-extractor.ts`, `src/mcp/ledger.ts`

#### extractReviewFindings 改修 (FR-9)

```typescript
entries.push({
  id,
  type: "bad",
  title: truncate(description, 100),
  context: `Review finding from task ${taskSlug}`,
  pattern: `[${severity}] ${fileRef} — ${truncate(description, 500)}`,
  applicationConditions: "When similar code patterns are encountered",
  expectedOutcomes: "Avoid repeating this anti-pattern",
  tags: ["review-finding", taskSlug],  // ← review-finding タグ
  createdAt: now,
  status: "draft",  // ← draft のまま（通常検索から除外）
  lang,
});
```

**検索除外**: 既存の `searchKnowledgeFTS` と `searchPipeline` は `enabled = 1` フィルタを使用。review-finding は `status="draft"` だが `enabled=1` のため検索に含まれる。対応: `extractReviewFindings` で保存する際に `enabled=0` とし、`ledger verify outcome=confirmed` で `enabled=1` に切り替える。

→ `saveKnowledgeEntries` に `enabled` パラメータを追加（デフォルト true、review-findingは false）。

#### ledgerVerify 改修 (FR-10)

```typescript
async function ledgerVerify(store, params) {
  // ... 既存の Leitner verify処理 ...

  // FR-10: review-finding の outcome 記録
  if (params.outcome) {
    const content = JSON.parse(doc.content);
    const isReviewFinding = Array.isArray(content.tags) && content.tags.includes("review-finding");

    if (isReviewFinding) {
      if (params.outcome === "confirmed") {
        content.status = "approved";
        store.db.prepare("UPDATE knowledge_index SET enabled = 1 WHERE id = ?").run(params.id);
      } else if (params.outcome === "rejected") {
        content.status = "rejected";
        // enabled は既に 0 のまま
      }
      atomicWriteSync(jsonPath, `${JSON.stringify(content, null, 2)}\n`);
    }
    // review-finding以外: outcomeは無視、通常verify動作のみ
  }

  return jsonResult({
    ...existingFields,
    ...(params.outcome ? { outcome: params.outcome } : {}),
  });
}
```

**Zodスキーマ更新**: MCP ツール定義のledger verify パラメータに `outcome` (enum: "confirmed" | "rejected", optional) を追加。

## vectorSearchKnowledge 改修

**変更ファイル**: `src/store/vectors.ts`

`minScore` パラメータを追加（デフォルトは既存の MIN_SIMILARITY=0.6）:

```typescript
export function vectorSearchKnowledge(
  store: Store,
  queryVec: number[],
  limit: number,
  minScore?: number, // 新規: 呼び出し側で最低スコアを指定可能
): VectorMatch[] {
  return vectorSearch(store, queryVec, ["knowledge"], limit, minScore);
}
```

## Requirements Traceability Matrix

| Req ID | Component | Task ID | Test ID |
|--------|-----------|---------|---------|
| FR-1 | code-reviewer Phase 1/3 | T-1.1 | TS-1.1 |
| FR-2 | attend findings永続化 + 構造比較 | T-1.2 | TS-1.2 |
| FR-3 | code-reviewer Phase 1/3 | T-1.1 | TS-1.3 |
| FR-4 | attend re-review template | T-1.3 | TS-2.1 |
| FR-5 | attend findings永続化 + code-reviewer JSON出力 | T-1.2, T-1.3 | TS-2.2 |
| FR-6 | quality-gate.ts + vectors.ts minScore | T-2.1 | TS-3.1 |
| FR-7 | quality-gate.ts checkActionability | T-2.2 | TS-3.2 |
| FR-8 | quality-gate.ts + classifyConflict | T-2.1 | TS-3.3 |
| FR-9 | knowledge-extractor.ts | T-3.1 | TS-4.1 |
| FR-10 | ledger.ts ledgerVerify + Zodスキーマ | T-3.2 | TS-4.2 |
| NFR-1 | quality-gate.ts timeout | T-2.1 | TS-3.4 |
| NFR-2 | quality-gate.ts emb guard | T-2.1 | TS-3.5 |
| NFR-3 | ledger.ts response shape | T-2.1 | TS-3.6 |
| NFR-4 | プロンプトファイル分離 | T-1.1 | — |

## Data Models

### review-findings-{slug}.json (.alfred/.state/)

```typescript
interface ReviewFindings {
  slug: string;
  wave: number;
  reviewed_at: string;
  findings: ReviewFinding[];
}

interface ReviewFinding {
  id: string;        // hash(file + ":" + line + ":" + category)
  file: string;
  line: number;
  severity: "critical" | "high" | "warning" | "info";
  category: "security" | "logic" | "design";
  summary: string;
}
```

ライフサイクル: Wave ごとに上書き。`dossier complete` 時に削除。

### QualityWarning, SimilarEntry (品質ゲートレスポンス)

（上述の interface 定義の通り）

## Tech Decisions

- **DEC-1**: トリアージはPhase 3プロンプト強化で実装。理由: エージェント数据え置き
- **DEC-2**: findings永続化は attend (orchestrator) が Write する。理由: code-reviewerのdisallowedTools: Write,Edit
- **DEC-3**: near_duplicate閾値 0.90（Mem0の0.90を参考に設定。BLOCKではなくWARNING）
- **DEC-4**: qualityGateはWARNINGのみ、BLOCKしない。理由: self-bias回避
- **DEC-5**: embedding await + タイムアウト3秒。再利用でinsertEmbedding 2回計算回避。タイムアウト時は既存の非同期フォールバック
- **DEC-6**: キャリブレーション: review-findingはenabled=0で保存、verify outcome=confirmedでenabled=1に。通常検索への混入を防止
- **DEC-7**: オシレーション検出: findingId (hash) による構造比較。attend側でコード的に実行（プロンプト判断ではない）
- **DEC-8**: qualityGateを独立モジュール (quality-gate.ts) に切り出し。ledgerSaveの責務肥大化を防止
- **DEC-9**: classifyConflictには構築済みentry（JSON.stringify(entry)）を渡す。paramsのstringifyはノイズ混入
- **DEC-10**: vectorSearchKnowledgeにminScoreパラメータ追加。品質ゲートではminScore=0.70, limit=15で候補取得
