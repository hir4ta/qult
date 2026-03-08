package store

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"sort"
	"strings"
)

// CountEmbeddings returns the total number of stored embeddings.
func (s *Store) CountEmbeddings() (int, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM embeddings").Scan(&n)
	return n, err
}

// InsertEmbedding stores a vector embedding as a BLOB.
// If ExpectedDims is set on the Store, validates that vector dimensions match.
func (s *Store) InsertEmbedding(source string, sourceID int64, model string, vector []float32) error {
	if s.ExpectedDims > 0 && len(vector) != s.ExpectedDims {
		return fmt.Errorf("store: insert embedding: dimension mismatch: got %d, expected %d", len(vector), s.ExpectedDims)
	}
	blob := serializeFloat32(vector)
	_, err := s.db.Exec(`
		INSERT OR REPLACE INTO embeddings (source, source_id, model, dims, vector)
		VALUES (?, ?, ?, ?, ?)`,
		source, sourceID, model, len(vector), blob,
	)
	if err != nil {
		return fmt.Errorf("store: insert embedding: %w", err)
	}
	return nil
}

// GetEmbedding retrieves a stored embedding vector.
func (s *Store) GetEmbedding(source string, sourceID int64) ([]float32, error) {
	var blob []byte
	err := s.db.QueryRow(`SELECT vector FROM embeddings WHERE source = ? AND source_id = ?`, source, sourceID).Scan(&blob)
	if err != nil {
		return nil, err
	}
	return deserializeFloat32(blob), nil
}

// minSimilarity is the cosine similarity threshold below which candidates are discarded.
// 0.3 is intentionally permissive: the reranker (Voyage rerank-2.5) handles precision,
// so the vector search stage optimizes for recall. Lowering risks noise; raising misses edge cases.
const minSimilarity = 0.3

// maxVectorCandidates caps the number of embeddings loaded into memory per search.
// At 2048 dims × 4 bytes × 10000 rows ≈ 80 MB — a reasonable upper bound for the
// expected knowledge base size (~1000-5000 docs). Beyond this, consider sqlite-vec.
const maxVectorCandidates = 10000

// VectorSearch performs a generic vector search on a given source table.
// Returns (sourceID, score) pairs sorted by descending similarity.
func (s *Store) VectorSearch(ctx context.Context, queryVec []float32, source string, limit int) ([]VectorMatch, error) {
	if queryVec == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}

	rows, err := s.db.QueryContext(ctx, `SELECT source_id, vector FROM embeddings WHERE source = ? LIMIT ?`, source, maxVectorCandidates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var candidates []VectorMatch
	for rows.Next() {
		var sourceID int64
		var blob []byte
		if err := rows.Scan(&sourceID, &blob); err != nil {
			if DebugLog != nil {
				DebugLog("store: VectorSearch scan error: %v", err)
			}
			continue // skip malformed rows; query itself succeeded
		}
		vec := deserializeFloat32(blob)
		if len(vec) != len(queryVec) {
			if DebugLog != nil {
				DebugLog("store: VectorSearch: dimension mismatch for source_id=%d (got %d, query %d), skipping", sourceID, len(vec), len(queryVec))
			}
			continue
		}
		sim := cosineSimilarity(queryVec, vec)
		if sim < minSimilarity {
			continue
		}
		candidates = append(candidates, VectorMatch{SourceID: sourceID, Score: sim})
	}
	if err := rows.Err(); err != nil {
		return candidates, fmt.Errorf("store: vector search iteration: %w", err)
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Score > candidates[j].Score
	})

	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates, nil
}

// VectorMatch represents a vector search result.
type VectorMatch struct {
	SourceID int64
	Score    float64
}

// cosineSimilarity computes the cosine similarity between two vectors.
func cosineSimilarity(a, b []float32) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}

	var dotProduct, normA, normB float64
	for i := range a {
		dotProduct += float64(a[i]) * float64(b[i])
		normA += float64(a[i]) * float64(a[i])
		normB += float64(b[i]) * float64(b[i])
	}

	if normA == 0 || normB == 0 {
		return 0
	}

	return dotProduct / (math.Sqrt(normA) * math.Sqrt(normB))
}

// serializeFloat32 converts a float32 slice to a little-endian byte slice.
func serializeFloat32(vec []float32) []byte {
	buf := make([]byte, len(vec)*4)
	for i, v := range vec {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(v))
	}
	return buf
}

// deserializeFloat32 converts a little-endian byte slice back to float32 slice.
func deserializeFloat32(blob []byte) []float32 {
	n := len(blob) / 4
	vec := make([]float32, n)
	for i := range n {
		vec[i] = math.Float32frombits(binary.LittleEndian.Uint32(blob[i*4:]))
	}
	return vec
}

// rrfK is the Reciprocal Rank Fusion constant. A standard value of 60 balances
// contributions from highly ranked and lower ranked results.
const rrfK = 60

// HybridMatch represents a combined vector + FTS5 search result.
type HybridMatch struct {
	DocID    int64
	RRFScore float64
}

// HybridSearch combines vector search and FTS5 search using Reciprocal Rank Fusion.
// Both search methods run independently and results are merged by RRF score.
// The overRetrieve parameter controls how many candidates each method retrieves
// before fusion (typically 3-4x the desired final limit).
func (s *Store) HybridSearch(ctx context.Context, queryVec []float32, ftsQuery string, sourceType string, limit int, overRetrieve int) ([]HybridMatch, error) {
	if limit <= 0 {
		limit = 5
	}
	if overRetrieve <= 0 {
		overRetrieve = limit * 4
	}

	scores := make(map[int64]float64)

	// Vector search — all embeddings are stored with source="docs" in the
	// embeddings table (the "source" column refers to the source table, not
	// the doc's source_type). Search once with "docs".
	matches, err := s.VectorSearch(ctx, queryVec, "docs", overRetrieve)
	if err == nil {
		for rank, m := range matches {
			scores[m.SourceID] += 1.0 / float64(rrfK+rank+1)
		}
	}

	// FTS5 search.
	if ftsQuery != "" {
		ftsResults, err := s.SearchDocsFTS(ctx, ftsQuery, sourceType, overRetrieve)
		if err == nil {
			for rank, d := range ftsResults {
				scores[d.ID] += 1.0 / float64(rrfK+rank+1)
			}
		}
	}

	if len(scores) == 0 {
		return nil, nil
	}

	// Sort by combined RRF score.
	candidates := make([]HybridMatch, 0, len(scores))
	for id, score := range scores {
		candidates = append(candidates, HybridMatch{DocID: id, RRFScore: score})
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].RRFScore > candidates[j].RRFScore
	})

	// Filter by doc source_type when specific types are requested.
	// Vector results may include docs with non-matching source_types
	// since all embeddings share source="docs" in the embeddings table.
	types := parseSourceTypes(sourceType)
	if len(types) > 0 {
		candidates = s.filterByDocSourceType(ctx, candidates, types)
	}

	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates, nil
}

// filterByDocSourceType removes HybridMatch entries whose doc source_type
// is not in the allowed list. Used after RRF fusion to clean up vector
// results that don't match the requested source_type filter.
func (s *Store) filterByDocSourceType(ctx context.Context, candidates []HybridMatch, types []string) []HybridMatch {
	if len(candidates) == 0 || len(types) == 0 {
		return candidates
	}
	ids := make([]int64, len(candidates))
	for i, c := range candidates {
		ids[i] = c.DocID
	}
	var qb strings.Builder
	qb.WriteString("SELECT id, source_type FROM docs WHERE id IN (")
	args := make([]any, len(ids))
	for i, id := range ids {
		if i > 0 {
			qb.WriteByte(',')
		}
		qb.WriteByte('?')
		args[i] = id
	}
	qb.WriteByte(')')
	rows, err := s.db.QueryContext(ctx, qb.String(), args...)
	if err != nil {
		return candidates // fail-open
	}
	defer rows.Close()

	allowed := make(map[string]bool, len(types))
	for _, t := range types {
		allowed[t] = true
	}
	valid := make(map[int64]bool)
	for rows.Next() {
		var id int64
		var st string
		if rows.Scan(&id, &st) == nil && allowed[st] {
			valid[id] = true
		}
	}
	filtered := make([]HybridMatch, 0, len(candidates))
	for _, c := range candidates {
		if valid[c.DocID] {
			filtered = append(filtered, c)
		}
	}
	return filtered
}

