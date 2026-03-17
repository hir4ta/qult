package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/mark3labs/mcp-go/mcp"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// Recency signal constants.
// Applied post-rerank to boost newer knowledge entries.
const (
	recencyFloor = 0.5 // minimum multiplier (never suppress below 50%)
)

// truncate shortens a string to maxLen runes, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}

// recencyFactor computes a multiplicative recency signal for a knowledge entry.
// Uses exponential decay with sub-type-aware half-life from store.SubTypeHalfLife.
// Returns 1.0 for missing timestamps.
func recencyFactor(createdAt string, subType string, now time.Time) float64 {
	halfLife := store.SubTypeHalfLife(subType)
	if halfLife <= 0 {
		return 1.0
	}
	t, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		t, err = time.Parse("2006-01-02 15:04:05", createdAt)
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

// scoredDoc pairs a KnowledgeRow with a sortable score for recency-based reordering.
type scoredDoc struct {
	doc   store.KnowledgeRow
	score float64 // original position score * recency factor
}

// applyRecencySignal reorders docs by applying a recency boost.
// Original ordering (from rerank or vector search) is encoded as a position-based score,
// then multiplied by the recency factor. This preserves semantic relevance as the
// primary signal while giving a boost to newer memories.
func applyRecencySignal(docs []store.KnowledgeRow, now time.Time) []store.KnowledgeRow {
	if len(docs) == 0 {
		return docs
	}

	scored := make([]scoredDoc, len(docs))
	for i, d := range docs {
		// Position-based score: first doc = 1.0, last = 1/n.
		posScore := 1.0 / float64(i+1)
		rf := recencyFactor(d.CreatedAt, d.SubType, now)
		stb := store.SubTypeBoost(d.SubType)
		scored[i] = scoredDoc{doc: d, score: posScore * rf * stb}
	}

	// Single doc: apply factor but skip sort.
	if len(scored) > 1 {
		// SliceStable preserves original (relevance) order on score ties.
		sort.SliceStable(scored, func(i, j int) bool {
			return scored[i].score > scored[j].score
		})
	}

	result := make([]store.KnowledgeRow, len(scored))
	for i, s := range scored {
		result[i] = s.doc
	}
	return result
}

// SearchResult holds the output of a search pipeline.
type SearchResult struct {
	Docs         []store.KnowledgeRow
	SearchMethod string // "vector+rerank", "vector", or "keyword"
	Warnings     []string
}

// searchPipeline runs vector search with rerank and recency signal.
// Falls back to LIKE-based keyword search when embedder is unavailable.
func SearchPipeline(ctx context.Context, st *store.Store, emb *embedder.Embedder, query string, limit, overRetrieve int) SearchResult {
	var res SearchResult

	if emb != nil {
		queryVec, err := emb.EmbedForSearch(ctx, query)
		if err != nil {
			res.Warnings = append(res.Warnings, fmt.Sprintf("vector embedding failed: %v", err))
		} else {
			matches, err := st.VectorSearchKnowledge(ctx, queryVec, overRetrieve)
			if err != nil {
				res.Warnings = append(res.Warnings, fmt.Sprintf("vector search failed: %v", err))
			} else if len(matches) > 0 {
				ids := make([]int64, len(matches))
				for i, m := range matches {
					ids[i] = m.SourceID
				}
				docs, err := st.GetKnowledgeByIDs(ctx, ids)
				if err != nil {
					res.Warnings = append(res.Warnings, fmt.Sprintf("doc fetch failed: %v", err))
				} else {
					// Preserve vector similarity ordering.
					docMap := make(map[int64]store.KnowledgeRow, len(docs))
					for _, d := range docs {
						docMap[d.ID] = d
					}
					ordered := make([]store.KnowledgeRow, 0, len(ids))
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
							contents[i] = d.Title + "\n" + d.Content
						}
						reranked, err := emb.Rerank(ctx, query, contents, limit)
						if err != nil {
							res.Warnings = append(res.Warnings, fmt.Sprintf("rerank failed: %v", err))
						} else if len(reranked) > 0 {
							reorderedDocs := make([]store.KnowledgeRow, 0, len(reranked))
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

	// Fallback to FTS5 search (with alias expansion + fuzzy) if no vector results.
	if len(res.Docs) == 0 {
		res.SearchMethod = "fts5"
		docs, err := st.SearchKnowledgeFTS(ctx, query, limit)
		if err != nil {
			res.Warnings = append(res.Warnings, fmt.Sprintf("fts5 search failed: %v", err))
			// Final fallback to LIKE keyword search.
			res.SearchMethod = "keyword"
			docs, err = st.SearchKnowledgeKeyword(ctx, query, limit)
			if err != nil {
				res.Warnings = append(res.Warnings, fmt.Sprintf("keyword search failed: %v", err))
			} else {
				res.Docs = docs
			}
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

// TrackHitCounts increments hit_count for the given search results.
// Call separately from SearchPipeline to allow callers (e.g., benchmarks) to opt out.
func TrackHitCounts(ctx context.Context, st *store.Store, docs []store.KnowledgeRow) {
	if len(docs) == 0 {
		return
	}
	ids := make([]int64, 0, len(docs))
	for _, d := range docs {
		if d.ID > 0 {
			ids = append(ids, d.ID)
		}
	}
	_ = st.IncrementHitCount(ctx, ids)
}

// marshalResult encodes v as JSON and wraps it in an MCP CallToolResult.
func marshalResult(v any) (*mcp.CallToolResult, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("marshal result: %w", err)
	}
	return mcp.NewToolResultText(string(data)), nil
}
