---
paths:
  - "internal/store/**"
---

# Store Implementation Patterns

## Vector Search
- BLOB storage + Go native cosine similarity (no sqlite-vec)
- Dimension validation on insert
- `embeddings.source` always "docs" (source_type filtered via docs table JOIN)

## SQL Safety
- LIKE queries: use `escapeLIKEPrefix()` / `escapeLIKEContains()` + `ESCAPE '\'` clause to prevent wildcard injection
- SearchMemoriesKeyword: LIKE-based fallback for no-Voyage-key mode

## Schema
- DB schema V8: incremental migration (V3+ preserves data, legacy schemas rebuilt)
- Tables: docs (memories/specs/project), embeddings (vector BLOBs), schema_version
- Store.DB() is test-only; production code uses Store methods (no raw SQL outside internal/store)
