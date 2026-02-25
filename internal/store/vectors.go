package store

import (
	"encoding/binary"
	"fmt"
	"math"
)

// InsertEmbedding stores a vector embedding as a BLOB.
func (s *Store) InsertEmbedding(source string, sourceID int64, model string, vector []float32) error {
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

// SearchPatternsByVector performs vector-only search using cosine similarity.
// Returns nil if queryVec is nil.
func (s *Store) SearchPatternsByVector(queryVec []float32, patternType string, limit int) ([]PatternRow, error) {
	if queryVec == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}
	return s.vectorSearchPatterns(queryVec, patternType, limit)
}

// vectorSearchPatterns retrieves all pattern embeddings and ranks by cosine similarity.
func (s *Store) vectorSearchPatterns(queryVec []float32, patternType string, limit int) ([]PatternRow, error) {
	// Load all pattern embeddings.
	rows, err := s.db.Query(`
		SELECT e.source_id, e.vector FROM embeddings e
		WHERE e.source = 'patterns'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type scored struct {
		id    int64
		score float64
	}
	var candidates []scored

	for rows.Next() {
		var sourceID int64
		var blob []byte
		if err := rows.Scan(&sourceID, &blob); err != nil {
			continue
		}
		vec := deserializeFloat32(blob)
		sim := cosineSimilarity(queryVec, vec)
		candidates = append(candidates, scored{id: sourceID, score: sim})
	}

	// Sort by similarity (descending).
	for i := 1; i < len(candidates); i++ {
		for j := i; j > 0 && candidates[j].score > candidates[j-1].score; j-- {
			candidates[j], candidates[j-1] = candidates[j-1], candidates[j]
		}
	}

	// Load pattern rows for top results.
	var result []PatternRow
	for _, c := range candidates {
		if len(result) >= limit {
			break
		}
		p, err := s.getPatternByID(c.id)
		if err != nil {
			continue
		}
		if patternType != "" && p.PatternType != patternType {
			continue
		}
		result = append(result, *p)
	}

	return result, nil
}

// getPatternByID loads a single pattern by ID.
func (s *Store) getPatternByID(id int64) (*PatternRow, error) {
	var p PatternRow
	err := s.db.QueryRow(`
		SELECT id, session_id, pattern_type, title, content, embed_text,
			COALESCE(language,''), scope, COALESCE(source_event_id,0), timestamp
		FROM patterns WHERE id = ?`, id).
		Scan(&p.ID, &p.SessionID, &p.PatternType, &p.Title, &p.Content, &p.EmbedText,
			&p.Language, &p.Scope, &p.SourceEventID, &p.Timestamp)
	if err != nil {
		return nil, err
	}
	p.Tags = s.getPatternTags(p.ID)
	p.Files = s.getPatternFiles(p.ID)
	return &p, nil
}

// EmbedPending generates embeddings for patterns that don't have one yet.
// progressFn is called after each embedding is generated (can be nil).
func (s *Store) EmbedPending(embedFunc func(text string) ([]float32, error), model string, progressFn func(done, total int)) (int, error) {
	var total int
	s.db.QueryRow(`
		SELECT COUNT(*) FROM patterns p
		WHERE NOT EXISTS (
			SELECT 1 FROM embeddings e WHERE e.source = 'patterns' AND e.source_id = p.id
		)`).Scan(&total)

	rows, err := s.db.Query(`
		SELECT p.id, p.embed_text FROM patterns p
		WHERE NOT EXISTS (
			SELECT 1 FROM embeddings e WHERE e.source = 'patterns' AND e.source_id = p.id
		)`)
	if err != nil {
		return 0, fmt.Errorf("store: query pending embeddings: %w", err)
	}
	defer rows.Close()

	var count int
	for rows.Next() {
		var id int64
		var text string
		if err := rows.Scan(&id, &text); err != nil {
			continue
		}

		vec, err := embedFunc(text)
		if err != nil {
			continue
		}

		if err := s.InsertEmbedding("patterns", id, model, vec); err != nil {
			continue
		}
		count++
		if progressFn != nil {
			progressFn(count, total)
		}
	}

	return count, nil
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

