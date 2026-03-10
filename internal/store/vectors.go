package store

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
)

// envIntOrDefault reads an integer from an environment variable, returning
// fallback if the variable is unset, empty, or not a valid positive integer.
func envIntOrDefault(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

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

// defaultMaxVectorCandidates caps the number of embeddings scanned per search.
// At 2048 dims × 4 bytes × 10000 rows ≈ 80 MB scan — a reasonable upper bound for
// the expected knowledge base size (~1000-5000 docs). Beyond this, consider sqlite-vec.
// Override with ALFRED_MAX_VECTOR_CANDIDATES env var for larger corpora.
const defaultMaxVectorCandidates = 10000

// earlyStopThreshold is the cosine similarity above which a candidate is
// considered "high quality". When we accumulate 2x the requested limit
// of high-quality candidates, we stop scanning early.
const earlyStopThreshold = 0.7

// VectorSearch performs a generic vector search on a given source table.
// Returns (sourceID, score) pairs sorted by descending similarity.
// Supports early termination when enough high-quality candidates are found,
// and configurable scan limit via ALFRED_MAX_VECTOR_CANDIDATES env var.
// Optional docSourceTypes filters by doc source_type via JOIN (pre-filter),
// reducing wasted cosine computations on irrelevant document types.
func (s *Store) VectorSearch(ctx context.Context, queryVec []float32, source string, limit int, docSourceTypes ...string) ([]VectorMatch, error) {
	if queryVec == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}

	maxCandidates := envIntOrDefault("ALFRED_MAX_VECTOR_CANDIDATES", defaultMaxVectorCandidates)
	// Minimum 50 high-quality candidates before early stop to ensure sufficient
	// ranking diversity — SQLite returns rows in insertion order (not similarity),
	// so small thresholds risk missing better matches at higher row IDs.
	earlyStopCount := max(limit*3, 50)

	// Build query: optionally JOIN with docs to pre-filter by source_type,
	// avoiding cosine computation on irrelevant document types.
	var queryStr string
	var queryArgs []any
	if len(docSourceTypes) > 0 {
		var qb strings.Builder
		qb.WriteString("SELECT e.source_id, e.vector FROM embeddings e JOIN docs d ON d.id = e.source_id WHERE e.source = ? AND d.source_type IN (")
		queryArgs = append(queryArgs, source)
		for i, st := range docSourceTypes {
			if i > 0 {
				qb.WriteByte(',')
			}
			qb.WriteByte('?')
			queryArgs = append(queryArgs, st)
		}
		qb.WriteString(") LIMIT ?")
		queryArgs = append(queryArgs, maxCandidates)
		queryStr = qb.String()
	} else {
		queryStr = `SELECT source_id, vector FROM embeddings WHERE source = ? LIMIT ?`
		queryArgs = []any{source, maxCandidates}
	}

	rows, err := s.db.QueryContext(ctx, queryStr, queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var candidates []VectorMatch
	var rowsScanned, highQualityCount, dimMismatchCount int
	for rows.Next() {
		rowsScanned++
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
			dimMismatchCount++
			if DebugLog != nil && dimMismatchCount <= 3 {
				DebugLog("store: VectorSearch: dimension mismatch for source_id=%d (got %d, query %d), skipping", sourceID, len(vec), len(queryVec))
			}
			continue
		}
		sim := cosineSimilarity(queryVec, vec)
		if sim < minSimilarity {
			continue
		}
		candidates = append(candidates, VectorMatch{SourceID: sourceID, Score: sim})
		if sim >= earlyStopThreshold {
			highQualityCount++
			if highQualityCount >= earlyStopCount {
				if DebugLog != nil {
					DebugLog("store: VectorSearch: early stop after %d rows (%d high-quality candidates)", rowsScanned, highQualityCount)
				}
				break
			}
		}
	}
	if err := rows.Err(); err != nil {
		return candidates, fmt.Errorf("store: vector search iteration: %w", err)
	}

	// Warn if dimension mismatches occurred — may indicate stale embeddings.
	if dimMismatchCount > 0 && DebugLog != nil {
		DebugLog("store: VectorSearch: %d/%d embeddings had dimension mismatch (query=%d dims) — consider re-embedding with 'alfred init'", dimMismatchCount, rowsScanned, len(queryVec))
	}

	// Warn if scan hit the configured limit — recall may be degraded.
	if rowsScanned >= maxCandidates && DebugLog != nil {
		DebugLog("store: VectorSearch: hit maxVectorCandidates (%d) for source=%q — set ALFRED_MAX_VECTOR_CANDIDATES or consider sqlite-vec", maxCandidates, source)
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

	// Vector search — pre-filter by doc source_type via JOIN when specified,
	// so irrelevant document types don't consume RRF candidate slots.
	types := parseSourceTypes(sourceType)
	matches, err := s.VectorSearch(ctx, queryVec, "docs", overRetrieve, types...)
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

	// Safety net: filter by doc source_type post-fusion if types were specified.
	// Pre-filtered at VectorSearch level, but FTS results may still include
	// cross-type matches if the FTS query doesn't perfectly filter.
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
		if err := rows.Scan(&id, &st); err != nil {
			if DebugLog != nil {
				DebugLog("store: filterByDocSourceType scan error: %v", err)
			}
			continue
		}
		if allowed[st] {
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

