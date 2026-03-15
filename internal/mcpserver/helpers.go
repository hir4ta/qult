package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// Recency signal constants.
// Applied post-rerank to boost newer memories.
// Docs (crawled reference material) are not decayed because crawled_at
// reflects fetch time, not feature authoring time.
const (
	recencyHalfLifeMemory = 60.0 // days: memory half-life
	recencyFloor          = 0.5  // minimum multiplier (never suppress below 50%)
)

// truncate shortens a string to maxLen runes, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}

// recencyHalfLife returns the half-life in days for a given source type.
// Returns 0 for source types that should not be decayed.
func recencyHalfLife(sourceType string) float64 {
	switch sourceType {
	case store.SourceMemory:
		return recencyHalfLifeMemory
	default:
		return 0 // no decay
	}
}

// recencyFactor computes a multiplicative recency signal for a document.
// Uses exponential decay: factor = max(floor, exp(-ln2 * ageDays / halfLife)).
// Returns 1.0 for source types with no decay or missing timestamps.
func recencyFactor(crawledAt string, sourceType string, now time.Time) float64 {
	halfLife := recencyHalfLife(sourceType)
	if halfLife <= 0 {
		return 1.0
	}
	t, err := time.Parse(time.RFC3339, crawledAt)
	if err != nil {
		t, err = time.Parse("2006-01-02 15:04:05", crawledAt)
		if err != nil {
			return 1.0
		}
	}
	ageDays := now.Sub(t).Hours() / 24
	if ageDays <= 0 {
		return 1.0
	}
	factor := math.Exp(-math.Ln2 * ageDays / halfLife)
	if factor < recencyFloor {
		return recencyFloor
	}
	return factor
}

// scoredDoc pairs a DocRow with a sortable score for recency-based reordering.
type scoredDoc struct {
	doc   store.DocRow
	score float64 // original position score * recency factor
}

// applyRecencySignal reorders docs by applying a recency boost.
// Original ordering (from rerank or vector search) is encoded as a position-based score,
// then multiplied by the recency factor. This preserves semantic relevance as the
// primary signal while giving a boost to newer memories.
func applyRecencySignal(docs []store.DocRow, now time.Time) []store.DocRow {
	if len(docs) == 0 {
		return docs
	}

	// Check if any doc needs recency adjustment.
	needsAdjust := false
	for _, d := range docs {
		if recencyHalfLife(d.SourceType) > 0 {
			needsAdjust = true
			break
		}
	}
	if !needsAdjust {
		return docs
	}

	scored := make([]scoredDoc, len(docs))
	for i, d := range docs {
		// Position-based score: first doc = 1.0, last = 1/n.
		posScore := 1.0 / float64(i+1)
		rf := recencyFactor(d.CrawledAt, d.SourceType, now)
		scored[i] = scoredDoc{doc: d, score: posScore * rf}
	}

	// Single doc: apply factor but skip sort.
	if len(scored) > 1 {
		// SliceStable preserves original (relevance) order on score ties.
		sort.SliceStable(scored, func(i, j int) bool {
			return scored[i].score > scored[j].score
		})
	}

	result := make([]store.DocRow, len(scored))
	for i, s := range scored {
		result[i] = s.doc
	}
	return result
}

// searchResult holds the output of a search pipeline.
type searchResult struct {
	Docs         []store.DocRow
	SearchMethod string // "vector+rerank", "vector", or "keyword"
	Warnings     []string
}

// parseSourceTypes splits a comma-separated source_type string into individual types.
// Returns nil for empty input (meaning "all types").
func parseSourceTypes(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	types := parts[:0]
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			types = append(types, p)
		}
	}
	return types
}

// searchPipeline runs vector search with rerank and recency signal.
// Falls back to LIKE-based keyword search when embedder is unavailable.
func searchPipeline(ctx context.Context, st *store.Store, emb *embedder.Embedder, query, sourceType string, limit, overRetrieve int) searchResult {
	var res searchResult

	if emb != nil {
		queryVec, err := emb.EmbedForSearch(ctx, query)
		if err != nil {
			res.Warnings = append(res.Warnings, fmt.Sprintf("vector embedding failed: %v", err))
		} else {
			types := parseSourceTypes(sourceType)
			matches, err := st.VectorSearch(ctx, queryVec, "records", overRetrieve, types...)
			if err != nil {
				res.Warnings = append(res.Warnings, fmt.Sprintf("vector search failed: %v", err))
			} else if len(matches) > 0 {
				ids := make([]int64, len(matches))
				for i, m := range matches {
					ids[i] = m.SourceID
				}
				docs, err := st.GetDocsByIDs(ctx, ids)
				if err != nil {
					res.Warnings = append(res.Warnings, fmt.Sprintf("doc fetch failed: %v", err))
				} else {
					// Preserve vector similarity ordering.
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
					res.Docs = ordered
					res.SearchMethod = "vector"

					// Rerank via Voyage API if we have more results than needed.
					if len(res.Docs) > limit {
						contents := make([]string, len(res.Docs))
						for i, d := range res.Docs {
							contents[i] = d.SectionPath + "\n" + d.Content
						}
						reranked, err := emb.Rerank(ctx, query, contents, limit)
						if err != nil {
							res.Warnings = append(res.Warnings, fmt.Sprintf("rerank failed: %v", err))
						} else if len(reranked) > 0 {
							reorderedDocs := make([]store.DocRow, 0, len(reranked))
							for _, r := range reranked {
								if r.Index >= 0 && r.Index < len(res.Docs) {
									reorderedDocs = append(reorderedDocs, res.Docs[r.Index])
								}
							}
							res.Docs = reorderedDocs
							res.SearchMethod = "vector+rerank"
						}
					}
				}
			}
		}
	}

	// Fallback to LIKE keyword search if no vector results.
	if len(res.Docs) == 0 {
		res.SearchMethod = "keyword"
		docs, err := st.SearchMemoriesKeyword(ctx, query, limit)
		if err != nil {
			res.Warnings = append(res.Warnings, fmt.Sprintf("keyword search failed: %v", err))
		} else {
			res.Docs = docs
		}
	}

	// Apply recency signal.
	res.Docs = applyRecencySignal(res.Docs, time.Now())

	if len(res.Docs) > limit {
		res.Docs = res.Docs[:limit]
	}
	return res
}

// marshalResult encodes v as JSON and wraps it in an MCP CallToolResult.
func marshalResult(v any) (*mcp.CallToolResult, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("marshal result: %w", err)
	}
	return mcp.NewToolResultText(string(data)), nil
}
