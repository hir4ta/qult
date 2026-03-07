package mcpserver

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// Search tuning constants.
const (
	// overRetrieveMulti is the candidate multiplier for multi-word queries.
	overRetrieveMulti = 4
	// overRetrieveSingle is the candidate multiplier for single-word queries.
	overRetrieveSingle = 6
	// overRetrieveMin is the minimum number of candidates to retrieve.
	overRetrieveMin = 20
	// stalenessWarningDays is the age threshold for showing a staleness warning.
	stalenessWarningDays = 30
)

// docsSearchHandler searches the docs knowledge base using hybrid search:
// 1. Hybrid RRF (vector + FTS5 fusion) → over-retrieve candidates
// 2. Rerank top candidates via Voyage rerank API → return top results
func docsSearchHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		query := req.GetString("query", "")
		if query == "" {
			return mcp.NewToolResultError("query parameter is required"), nil
		}
		limit := req.GetInt("limit", 5)
		if limit < 1 {
			limit = 5
		}
		sourceType := req.GetString("source_type", "")

		var docs []store.DocRow
		searchMethod := "hybrid_rrf"

		// Try embedding the query for hybrid search (requires VOYAGE_API_KEY).
		var queryVec []float32
		if emb != nil {
			queryVec, _ = emb.EmbedForSearch(ctx, query)
		}

		if queryVec != nil {
			// Stage 1: Hybrid RRF search (vector + FTS5 combined).
			searchMethod = "hybrid_rrf"

			// Adaptive over-retrieve: short queries are vague, need more candidates.
			wordCount := len(strings.Fields(query))
			overRetrieve := limit * overRetrieveMulti
			if wordCount <= 1 {
				overRetrieve = limit * overRetrieveSingle
			}
			if overRetrieve < overRetrieveMin {
				overRetrieve = overRetrieveMin
			}

			hybridMatches, err := st.HybridSearch(queryVec, query, sourceType, overRetrieve, overRetrieve)
			if err != nil {
				_ = err // hybrid search unavailable; results may be incomplete
			}

			if len(hybridMatches) > 0 {
				ids := make([]int64, len(hybridMatches))
				for i, m := range hybridMatches {
					ids[i] = m.DocID
				}
				docs, err = st.GetDocsByIDs(ids)
				if err != nil {
					return mcp.NewToolResultError(fmt.Sprintf("failed to retrieve docs: %v", err)), nil
				}

				// Preserve RRF ordering (GetDocsByIDs may reorder).
				if len(docs) > 1 {
					docMap := make(map[int64]store.DocRow, len(docs))
					for _, d := range docs {
						docMap[d.ID] = d
					}
					ordered := make([]store.DocRow, 0, len(ids))
					for _, id := range ids {
						if d, ok := docMap[id]; ok {
							ordered = append(ordered, d)
						}
					}
					docs = ordered
				}

				// Stage 2: Rerank via Voyage rerank API.
				if len(docs) > limit {
					contents := make([]string, len(docs))
					for i, d := range docs {
						contents[i] = d.SectionPath + "\n" + d.Content
					}
					reranked, err := emb.Rerank(ctx, query, contents, limit)
					if err == nil && len(reranked) > 0 {
						reorderedDocs := make([]store.DocRow, 0, len(reranked))
						for _, r := range reranked {
							if r.Index >= 0 && r.Index < len(docs) {
								reorderedDocs = append(reorderedDocs, docs[r.Index])
							}
						}
						docs = reorderedDocs
						searchMethod = "hybrid_rrf+rerank"
					}
				}

				// Trim to requested limit.
				if len(docs) > limit {
					docs = docs[:limit]
				}
			}
		} else {
			// FTS5-only fallback (no embedder available).
			var ftsErr error
			docs, ftsErr = st.SearchDocsFTS(query, sourceType, limit)
			if ftsErr != nil {
				return mcp.NewToolResultError(fmt.Sprintf("FTS search failed: %v", ftsErr)), nil
			}
		}

		// Build response with freshness metadata.
		docResults := make([]map[string]any, 0, len(docs))
		maxAgeDays := 0
		for _, d := range docs {
			dm := map[string]any{
				"type":         "docs",
				"url":          d.URL,
				"section_path": d.SectionPath,
				"content":      d.Content,
				"source_type":  d.SourceType,
			}
			if d.Version != "" {
				dm["version"] = d.Version
			}
			if d.CrawledAt != "" {
				if t, err := time.Parse(time.RFC3339, d.CrawledAt); err == nil {
					age := int(time.Since(t).Hours() / 24)
					dm["freshness_days"] = age
					if age > maxAgeDays {
						maxAgeDays = age
					}
				} else if t, err := time.Parse("2006-01-02 15:04:05", d.CrawledAt); err == nil {
					age := int(time.Since(t).Hours() / 24)
					dm["freshness_days"] = age
					if age > maxAgeDays {
						maxAgeDays = age
					}
				}
			}
			docResults = append(docResults, dm)
		}

		result := map[string]any{
			"query":         query,
			"results":       docResults,
			"docs_count":    len(docResults),
			"search_method": searchMethod,
		}
		if maxAgeDays > stalenessWarningDays {
			result["staleness_warning"] = fmt.Sprintf(
				"Results include docs from %d days ago. Run 'alfred init' to refresh.", maxAgeDays)
		}

		return marshalResult(result)
	}
}
