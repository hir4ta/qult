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

// envIntOrDefault reads an integer from an environment variable.
func envIntOrDefault(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

// InsertEmbedding stores a vector embedding as a BLOB.
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

// CleanOrphanedEmbeddings removes embeddings whose source_id no longer exists
// in the knowledge_index table.
func (s *Store) CleanOrphanedEmbeddings() (int64, error) {
	res, err := s.db.Exec(
		`DELETE FROM embeddings WHERE source = 'knowledge'
		 AND source_id NOT IN (SELECT id FROM knowledge_index)`)
	if err != nil {
		return 0, fmt.Errorf("store: clean orphaned embeddings: %w", err)
	}
	return res.RowsAffected()
}

const minSimilarity = 0.3
const defaultMaxVectorCandidates = 10000
const earlyStopThreshold = 0.7

// VectorSearchKnowledge performs vector search on knowledge embeddings.
// Returns (sourceID, score) pairs sorted by descending similarity.
func (s *Store) VectorSearchKnowledge(ctx context.Context, queryVec []float32, limit int) ([]VectorMatch, error) {
	if queryVec == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}

	maxCandidates := envIntOrDefault("ALFRED_MAX_VECTOR_CANDIDATES", defaultMaxVectorCandidates)
	earlyStopCount := max(limit*3, 50)

	// Join with knowledge_index to filter only enabled entries.
	var qb strings.Builder
	qb.WriteString(`SELECT e.source_id, e.vector FROM embeddings e
		JOIN knowledge_index k ON k.id = e.source_id
		WHERE e.source = 'knowledge' AND k.enabled = 1
		LIMIT ?`)

	rows, err := s.db.QueryContext(ctx, qb.String(), maxCandidates)
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
			continue
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

func serializeFloat32(vec []float32) []byte {
	buf := make([]byte, len(vec)*4)
	for i, v := range vec {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(v))
	}
	return buf
}

func deserializeFloat32(blob []byte) []float32 {
	n := len(blob) / 4
	vec := make([]float32, n)
	for i := range n {
		vec[i] = math.Float32frombits(binary.LittleEndian.Uint32(blob[i*4:]))
	}
	return vec
}
