package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/embedder"
	"github.com/hir4ta/claude-buddy/internal/store"
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

		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func patternsHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		query := req.GetString("query", "")
		if query == "" {
			return mcp.NewToolResultError("query parameter is required"), nil
		}

		patternType := req.GetString("type", "")
		limit := req.GetInt("limit", 5)
		if limit < 1 {
			limit = 5
		}

		var patterns []store.PatternRow
		var searchMethod string

		if emb != nil && emb.Available() {
			queryVec, err := emb.EmbedForSearch(ctx, query)
			if err == nil && queryVec != nil {
				patterns, err = st.SearchPatternsByVector(queryVec, patternType, limit)
				if err == nil {
					searchMethod = "vector"
				} else {
					fmt.Fprintf(os.Stderr, "[buddy] vector search failed, falling back: %v\n", err)
				}
			}
		}

		// FTS5 BM25 fallback when vector search unavailable or failed.
		if searchMethod == "" {
			var err error
			patterns, err = st.SearchPatternsByFTS(query, patternType, limit)
			if err == nil && len(patterns) > 0 {
				searchMethod = "fts5"
			} else if err != nil {
				fmt.Fprintf(os.Stderr, "[buddy] fts5 search failed, falling back: %v\n", err)
			}
		}

		// LIKE fallback as last resort.
		if searchMethod == "" {
			var err error
			patterns, err = st.SearchPatternsByKeyword(query, patternType, limit)
			if err != nil {
				return mcp.NewToolResultError("search failed: " + err.Error()), nil
			}
			searchMethod = "keyword"
		}

		total, _ := st.CountPatterns()

		patternList := make([]map[string]any, 0, len(patterns))
		for _, p := range patterns {
			patternList = append(patternList, store.PatternJSON(p))
		}

		result := map[string]any{
			"query":          query,
			"patterns":       patternList,
			"total_patterns": total,
			"search_method":  searchMethod,
		}

		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}
