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

// InsertEmbedding stores a vector embedding as a BLOB.
// If ExpectedDims is set on the Store, validates that vector dimensions match.
// Also cleans up orphaned embeddings for the same source that reference
// non-existent docs (can occur when docs are upserted with new IDs).
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

	// Clean up orphaned embeddings: remove entries whose source_id no longer
	// exists in the records table. This handles cases where records were upserted
	// with new IDs (e.g., DELETE + INSERT via schema migration or re-init).
	if source == "records" {
		_, _ = s.db.Exec(`DELETE FROM embeddings WHERE source = 'records' AND source_id NOT IN (SELECT id FROM records)`)
	}
	return nil
}

// minSimilarity is the cosine similarity threshold below which candidates are discarded.
// 0.3 is intentionally permissive: the reranker handles precision,
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

	// Build query: optionally JOIN with records to pre-filter by source_type,
	// avoiding cosine computation on irrelevant record types.
	var queryStr string
	var queryArgs []any
	if len(docSourceTypes) > 0 {
		var qb strings.Builder
		qb.WriteString("SELECT e.source_id, e.vector FROM embeddings e JOIN records d ON d.id = e.source_id WHERE e.source = ? AND d.source_type IN (")
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
	var highQualityCount int
	for rows.Next() {
		var sourceID int64
		var blob []byte
		if err := rows.Scan(&sourceID, &blob); err != nil {
			continue // skip malformed rows; query itself succeeded
		}
		vec := deserializeFloat32(blob)
		if len(vec) != len(queryVec) {
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
				break
			}
		}
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
