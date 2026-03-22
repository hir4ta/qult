---
paths:
  - "src/store/**"
---

# Store Implementation Patterns

## Vector Search
- BLOB storage + TypeScript native cosine similarity (no sqlite-vec)
- Dimension validation on insert
- `embeddings.source` = "knowledge" | "spec" (polymorphic, JOIN with respective index table)
- `vectorSearch()` accepts `sources` array for cross-source search
- `cleanOrphanedEmbeddings()` handles both knowledge and spec orphans

## SQL Safety
- LIKE queries: use `escapeLIKEContains()` + `ESCAPE '\'` clause to prevent wildcard injection
- SearchKnowledgeKeyword: LIKE-based fallback for no-Voyage-key mode

## Schema
- DB schema V10: multi-project architecture (V10 is full rewrite via rebuildFromScratch; any pre-V10 DB rebuilt)
- Tables: projects (UUID registry), knowledge_index (FK→projects, author), spec_index (FK→projects), audit_log (FK→projects, UNIQUE dedup), embeddings (source: "knowledge"|"spec"), schema_version, knowledge_fts (FTS5), spec_fts (FTS5), tag_aliases, session_links
- `projects` table: UUID v4 id, name, remote, path, status (active/archived/missing). `resolveOrRegisterProject()` auto-registers on first use
- `knowledge_index`: project_id FK (ON DELETE CASCADE), UNIQUE(project_id, file_path), `author` column (git user.name)
- `spec_index`: project_id FK (ON DELETE CASCADE), UNIQUE(project_id, slug, file_name). Synced via `syncProjectSpecs()` at dashboard startup
- `audit_log`: project_id FK, UNIQUE(project_id, timestamp, event, actor, slug). Synced from audit.jsonl at dashboard startup via watermark
- `enabled` column: INTEGER DEFAULT 1; all knowledge search queries filter by `enabled = 1`
- Store.DB() is test-only; production code uses Store methods

## Search
- SubTypeHalfLife(subType) in fts.ts: assumption=30d, inference=45d, snapshot=30d, pattern=90d, decision=90d, rule=120d
- DetectKnowledgeConflicts threshold 0.70 with classifyConflict keyword polarity
- `detectCrossProjectConflicts()`: pairwiseSimilarity with crossProjectOnly + maxEmbeddings=500 cap (O(n²) safety)
- `mineCommonPatterns()`: Voyage-only, 30s timeout, 3+ project cluster detection
- `findSimilarSpecs()`: vector similarity >= 0.60 with FTS5 fallback
- `pairwiseSimilarity()`: supports crossProjectOnly, subType filter, project_id enrichment
- `searchUnified()`: knowledge_fts + spec_fts cross-source FTS5 search with project JOIN filter
- Unified search API: `GET /api/search?q=&scope=all|knowledge|spec&project=<uuid>`
- All existing API endpoints accept `?project=<uuid>` filter for cross-project dashboard
