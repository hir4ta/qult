---
paths:
  - "internal/store/**"
---

# Store Implementation Patterns

## Vector Search
- BLOB storage + Go native cosine similarity (no sqlite-vec)
- Dimension validation on insert
- `embeddings.source` = "knowledge" (JOIN with knowledge_index for enabled filter)

## SQL Safety
- LIKE queries: use `escapeLIKEContains()` + `ESCAPE '\'` clause to prevent wildcard injection
- SearchKnowledgeKeyword: LIKE-based fallback for no-Voyage-key mode

## Schema
- DB schema V8: knowledge-first architecture (V8 is full rewrite; any pre-V8 DB rebuilt from scratch)
- Tables: knowledge_index (knowledge entries), embeddings (vector BLOBs), schema_version, knowledge_fts (FTS5), tag_aliases, session_links
- `enabled` column: INTEGER DEFAULT 1; all search queries filter by `enabled = 1`
- Project identification: project_remote (git remote URL) + project_path (directory) + branch
- UNIQUE constraint: (project_remote, project_path, file_path)
- Store.DB() is test-only; production code uses Store methods

## Search
- SubTypeHalfLife(subType) in fts.go: assumption=30d, inference=45d, general=60d, pattern=90d, decision=90d, rule=120d
- DetectKnowledgeConflicts threshold 0.70 with classifyConflict keyword polarity
