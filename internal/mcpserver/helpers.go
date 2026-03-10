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
// Applied post-rerank to boost newer memories and changelogs.
// Docs (crawled reference material) are not decayed because crawled_at
// reflects fetch time, not feature authoring time.
const (
	recencyHalfLifeMemory    = 60.0  // days: memory half-life
	recencyHalfLifeChangelog = 30.0  // days: changelog half-life
	recencyFloor             = 0.5   // minimum multiplier (never suppress below 50%)
)

// KBSnippet is a compact knowledge base search result.
type KBSnippet struct {
	SectionPath string `json:"section_path"`
	Content     string `json:"content"`
	URL         string `json:"url"`
}

// Suggestion is a structured improvement suggestion with optional KB context.
type Suggestion struct {
	Severity     string     `json:"severity"`                 // "info", "warning"
	Category     string     `json:"category"`                 // "claude_md", "skills", "rules", "hooks", "mcp"
	Message      string     `json:"message"`
	Affected     []string   `json:"affected,omitempty"`
	BestPractice *KBSnippet `json:"best_practice,omitempty"`
}

// queryKB performs a FTS5 search against the knowledge base and returns
// compact snippets. Designed for internal use by review/suggest — cheap
// FTS5 queries with no Voyage API calls.
// Returns nil when st is nil or query matches nothing.
func queryKB(ctx context.Context, st *store.Store, query string, limit int) []KBSnippet {
	if st == nil {
		return nil
	}
	if limit <= 0 {
		limit = 3
	}
	docs, err := st.SearchDocsFTS(ctx, query, store.SourceDocs, limit)
	if err != nil || len(docs) == 0 {
		return nil
	}
	snippets := make([]KBSnippet, len(docs))
	for i, d := range docs {
		snippets[i] = KBSnippet{
			SectionPath: d.SectionPath,
			Content:     truncate(d.Content, 300),
			URL:         d.URL,
		}
	}
	return snippets
}

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
	case store.SourceChangelog:
		return recencyHalfLifeChangelog
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
// Original ordering (from rerank or RRF) is encoded as a position-based score,
// then multiplied by the recency factor. This preserves semantic relevance as the
// primary signal while giving a boost to newer memories and changelogs.
func applyRecencySignal(docs []store.DocRow, now time.Time) []store.DocRow {
	if len(docs) <= 1 {
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

	// SliceStable preserves original (relevance) order on score ties.
	sort.SliceStable(scored, func(i, j int) bool {
		return scored[i].score > scored[j].score
	})

	result := make([]store.DocRow, len(scored))
	for i, s := range scored {
		result[i] = s.doc
	}
	return result
}

// hybridSearchResult holds the output of a hybrid search pipeline.
type hybridSearchResult struct {
	Docs         []store.DocRow
	SearchMethod string // "hybrid_rrf+rerank", "hybrid_rrf", or "fts5_only"
	Warnings     []string
}

// hybridSearchPipeline runs the 3-stage search: embed → hybrid RRF → rerank,
// with automatic FTS-only fallback. Shared by knowledge search and recall.
func hybridSearchPipeline(ctx context.Context, st *store.Store, emb *embedder.Embedder, query, sourceType string, limit, overRetrieve int) hybridSearchResult {
	var res hybridSearchResult
	res.SearchMethod = "fts5_only"

	// Stage 0: Embed the query.
	var queryVec []float32
	if emb != nil {
		var embedErr error
		queryVec, embedErr = emb.EmbedForSearch(ctx, query)
		if embedErr != nil {
			res.Warnings = append(res.Warnings, fmt.Sprintf("vector embedding failed, using FTS-only: %v", embedErr))
		}
	}

	if queryVec != nil {
		// Stage 1: Hybrid RRF search (vector + FTS5 combined).
		matches, hybridErr := st.HybridSearch(ctx, queryVec, query, sourceType, overRetrieve, overRetrieve)
		if hybridErr != nil {
			res.Warnings = append(res.Warnings, fmt.Sprintf("hybrid search degraded: %v", hybridErr))
		}
		if len(matches) > 0 {
			ids := make([]int64, len(matches))
			for i, m := range matches {
				ids[i] = m.DocID
			}
			docs, fetchErr := st.GetDocsByIDs(ctx, ids)
			if fetchErr != nil {
				res.Warnings = append(res.Warnings, fmt.Sprintf("doc fetch failed, using FTS-only: %v", fetchErr))
			} else {
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
				res.Docs = docs
				res.SearchMethod = "hybrid_rrf"

				// Stage 2: Rerank via Voyage rerank API.
				if len(res.Docs) > limit {
					contents := make([]string, len(res.Docs))
					for i, d := range res.Docs {
						contents[i] = d.SectionPath + "\n" + d.Content
					}
					reranked, rerankErr := emb.Rerank(ctx, query, contents, limit)
					if rerankErr != nil {
						res.Warnings = append(res.Warnings, fmt.Sprintf("rerank failed, using RRF order: %v", rerankErr))
					} else if len(reranked) > 0 {
						reorderedDocs := make([]store.DocRow, 0, len(reranked))
						for _, r := range reranked {
							if r.Index >= 0 && r.Index < len(res.Docs) {
								reorderedDocs = append(reorderedDocs, res.Docs[r.Index])
							}
						}
						res.Docs = reorderedDocs
						res.SearchMethod = "hybrid_rrf+rerank"
					}
				}
			}
		}
	}

	// Fallback to FTS-only if no results from hybrid pipeline.
	if len(res.Docs) == 0 {
		res.SearchMethod = "fts5_only"
		docs, err := st.SearchDocsFTS(ctx, query, sourceType, limit)
		if err != nil {
			res.Warnings = append(res.Warnings, fmt.Sprintf("FTS search failed: %v", err))
		} else {
			res.Docs = docs
		}
	}

	// Stage 3: Apply feedback boost (promote docs with positive user feedback).
	if len(res.Docs) > 1 {
		ids := make([]int64, len(res.Docs))
		for i, d := range res.Docs {
			ids[i] = d.ID
		}
		boosts := st.FeedbackBoostBatch(ctx, ids)
		if len(boosts) > 0 {
			type boostedDoc struct {
				doc   store.DocRow
				score float64
			}
			items := make([]boostedDoc, len(res.Docs))
			for i, d := range res.Docs {
				posScore := 1.0 / float64(i+1)
				if b, ok := boosts[d.ID]; ok {
					posScore += b - 1.0 // b is ~1.0 ± feedbackBoostScale
				}
				items[i] = boostedDoc{doc: d, score: posScore}
			}
			sort.SliceStable(items, func(i, j int) bool {
				return items[i].score > items[j].score
			})
			for i, item := range items {
				res.Docs[i] = item.doc
			}
		}
	}

	// Stage 4: Apply recency signal (boost newer memories/changelogs).
	res.Docs = applyRecencySignal(res.Docs, time.Now())

	// Trim to requested limit.
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
