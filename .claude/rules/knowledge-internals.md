# Knowledge & Search Internals

- Knowledge persistence: `.alfred/knowledge/{decisions,patterns,rules}/*.json` = source of truth; DB `knowledge_index` = derived search index
- Knowledge file format: JSON (mneme-compatible schemas: DecisionEntry, PatternEntry, RuleEntry)
- Sub-type classification: decision/pattern/rule (general abolished); boost: rule=2.0x, decision=1.5x, pattern=1.3x
- Knowledge maturity: hit_count tracks search appearances, last_accessed for staleness
- Knowledge promotion: pattern→rule (15+ hits); manual confirmation via ledger promote
- Ledger tool actions: search, save, promote, candidates, reflect, audit-conventions
- Search pipeline: Voyage vector search → rerank → recency signal → hit_count tracking → FTS5 fallback → keyword fallback. Returns ScoredDoc[] with per-doc score + matchReason
- FTS5: knowledge_fts virtual table with bm25 ranking, auto-synced via triggers (title weighted 3x)
- Tag alias expansion: auth→authentication/login/認証, 16 categories bilingual (EN/JP)
- Knowledge governance: `enabled` column in knowledge_index; disabled entries excluded from search
- Knowledge tab: toggle enabled/disabled via API (PATCH /api/knowledge/{id}/enabled)
- Knowledge files are git-friendly: team sharing via repository, diff-reviewable in PRs
