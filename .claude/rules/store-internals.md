---
paths:
  - "internal/store/**"
---

# Store Implementation Patterns

## Vector Search
- BLOB storage + Go native cosine similarity (no sqlite-vec)
- Dimension validation on insert
- `embeddings.source` always "records" (source_type filtered via records table JOIN)

## SQL Safety
- LIKE queries: use `escapeLIKEPrefix()` / `escapeLIKEContains()` + `ESCAPE '\'` clause to prevent wildcard injection
- SearchMemoriesKeyword: LIKE-based fallback for no-Voyage-key mode

## Schema
- DB schema V1: fresh start (pre-v1 schemas rebuilt from scratch)
- Tables: records (memories/specs/project), embeddings (vector BLOBs), schema_version
- Store.DB() is test-only; production code uses Store methods (no raw SQL outside internal/store)
