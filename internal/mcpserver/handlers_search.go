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
	// overRetrieveMulti (4x) is the candidate multiplier for multi-word queries.
	// Multi-word queries are more specific, so fewer candidates suffice for reranking.
	overRetrieveMulti = 4
	// overRetrieveSingle (6x) is the candidate multiplier for single-word queries.
	// Single-word queries are vague, so over-retrieve more to let the reranker pick well.
	overRetrieveSingle = 6
	// overRetrieveMin ensures at least 20 candidates for very small result sets.
	overRetrieveMin = 20
	// stalenessWarningDays (30) is the age threshold for showing a freshness warning.
	// Claude Code docs are typically re-crawled every 1-2 weeks; 30 days signals stale data.
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
		sourceType := req.GetString("source_type", "docs,memory")

		// Adaptive over-retrieve: short queries are vague, need more candidates.
		wordCount := len(strings.Fields(query))
		overRetrieve := limit * overRetrieveMulti
		if wordCount <= 1 {
			overRetrieve = limit * overRetrieveSingle
		}
		if overRetrieve < overRetrieveMin {
			overRetrieve = overRetrieveMin
		}

		sr := hybridSearchPipeline(ctx, st, emb, query, sourceType, limit, overRetrieve)
		docs := sr.Docs
		searchMethod := sr.SearchMethod
		warnings := sr.Warnings

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
		if len(warnings) > 0 {
			result["warning"] = strings.Join(warnings, "; ")
		}

		return marshalResult(result)
	}
}
