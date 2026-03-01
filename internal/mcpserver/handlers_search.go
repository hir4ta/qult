package mcpserver

import (
	"context"
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

func decisionsHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		sessionID := req.GetString("session_id", "")
		project := req.GetString("project", "")
		query := req.GetString("query", "")
		limit := req.GetInt("limit", 20)
		if limit < 1 {
			limit = 20
		}

		var decisions []store.DecisionRow
		var err error

		if query != "" {
			decisions, err = st.SearchDecisions(query, sessionID, limit)
		} else {
			decisions, err = st.GetDecisions(sessionID, project, limit)
		}
		if err != nil {
			return mcp.NewToolResultError("failed to get decisions: " + err.Error()), nil
		}

		decisionList := make([]map[string]any, 0, len(decisions))
		for _, d := range decisions {
			dm := map[string]any{
				"session_id": d.SessionID,
				"timestamp":  d.Timestamp,
				"topic":      d.Topic,
				"decision":   d.DecisionText,
			}
			if d.Reasoning != "" {
				dm["reasoning"] = d.Reasoning
			}
			if d.FilePaths != "" && d.FilePaths != "[]" {
				var paths []string
				if json.Unmarshal([]byte(d.FilePaths), &paths) == nil {
					dm["file_paths"] = paths
				}
			}
			decisionList = append(decisionList, dm)
		}

		result := map[string]any{
			"project":         project,
			"total_decisions": len(decisions),
			"decisions":       decisionList,
		}

		return marshalResult(result)
	}
}

// docsSearchHandler searches the docs knowledge base using hybrid search:
// 1. Hybrid RRF (vector + FTS5 fusion) → over-retrieve 20 candidates
// 2. Rerank top candidates via Voyage rerank API → return top 5
// 3. LIKE fallback if hybrid returns nothing.
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

		var docs []store.DocRow
		searchMethod := ""

		// Stage 1: Hybrid RRF search (vector + FTS5 combined).
		var queryVec []float32
		embAvailable := emb != nil && emb.Available()
		if embAvailable {
			queryVec, _ = emb.EmbedForSearch(ctx, query)
		}

		overRetrieve := limit * 4
		if overRetrieve < 20 {
			overRetrieve = 20
		}

		hybridMatches, _ := st.HybridSearch(queryVec, query, "", overRetrieve, overRetrieve)

		if len(hybridMatches) > 0 {
			ids := make([]int64, len(hybridMatches))
			for i, m := range hybridMatches {
				ids[i] = m.DocID
			}
			docs, _ = st.GetDocsByIDs(ids)

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

			if queryVec != nil {
				searchMethod = "hybrid_rrf"
			} else {
				searchMethod = "fts5"
			}

			// Stage 2: Rerank via Voyage rerank API (if available).
			if embAvailable && len(docs) > limit {
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

		// Fallback: LIKE search.
		if len(docs) == 0 {
			likeResults, err := st.SearchDocsLIKE(query, limit)
			if err == nil && len(likeResults) > 0 {
				docs = likeResults
				searchMethod = "like"
			}
		}

		// Also include decisions as supplemental results.
		decisions, _ := st.SearchDecisions(query, "", 3)

		// Build response.
		docResults := make([]map[string]any, 0, len(docs))
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
			docResults = append(docResults, dm)
		}

		decisionResults := make([]map[string]any, 0, len(decisions))
		for _, d := range decisions {
			decisionResults = append(decisionResults, map[string]any{
				"type":    "decision",
				"topic":   d.Topic,
				"content": d.DecisionText,
			})
		}

		// Merge results: docs first, then decisions.
		allResults := make([]map[string]any, 0, len(docResults)+len(decisionResults))
		allResults = append(allResults, docResults...)
		allResults = append(allResults, decisionResults...)

		result := map[string]any{
			"query":         query,
			"results":       allResults,
			"docs_count":    len(docResults),
			"search_method": searchMethod,
		}
		if searchMethod == "" && len(decisionResults) > 0 {
			result["search_method"] = "decisions_only"
		}
		if searchMethod == "" && len(allResults) == 0 {
			result["note"] = "No results found. Run /alfred-crawl to populate the knowledge base."
		}

		return marshalResult(result)
	}
}
