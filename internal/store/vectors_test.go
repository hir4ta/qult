package store

import (
	"context"
	"math"
	"testing"
)

func TestSerializeDeserializeFloat32(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		vec  []float32
	}{
		{"empty", []float32{}},
		{"single", []float32{3.14}},
		{"multiple", []float32{1.0, 2.0, 3.0, 4.0, 5.0}},
		{"negative", []float32{-1.5, 0.0, 0.0, 1.5}},
		{"special", []float32{float32(math.Inf(1)), float32(math.Inf(-1)), float32(math.NaN())}},
		{"very small", []float32{1e-38, -1e-38}},
		{"very large", []float32{1e38, -1e38}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			blob := serializeFloat32(tt.vec)
			got := deserializeFloat32(blob)
			if len(got) != len(tt.vec) {
				t.Fatalf("deserializeFloat32(serializeFloat32(%v)) length = %d, want %d", tt.vec, len(got), len(tt.vec))
			}
			for i := range tt.vec {
				if math.IsNaN(float64(tt.vec[i])) {
					if !math.IsNaN(float64(got[i])) {
						t.Errorf("index %d: got %v, want NaN", i, got[i])
					}
					continue
				}
				if got[i] != tt.vec[i] {
					t.Errorf("index %d: got %v, want %v", i, got[i], tt.vec[i])
				}
			}
		})
	}
}

func TestCosineSimilarity(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		a, b    []float32
		wantMin float64
		wantMax float64
	}{
		{
			name:    "parallel vectors",
			a:       []float32{1, 0, 0},
			b:       []float32{2, 0, 0},
			wantMin: 0.99, wantMax: 1.01,
		},
		{
			name:    "identical vectors",
			a:       []float32{1, 2, 3},
			b:       []float32{1, 2, 3},
			wantMin: 0.99, wantMax: 1.01,
		},
		{
			name:    "orthogonal vectors",
			a:       []float32{1, 0, 0},
			b:       []float32{0, 1, 0},
			wantMin: -0.01, wantMax: 0.01,
		},
		{
			name:    "opposite vectors",
			a:       []float32{1, 0, 0},
			b:       []float32{-1, 0, 0},
			wantMin: -1.01, wantMax: -0.99,
		},
		{
			name:    "zero vector a",
			a:       []float32{0, 0, 0},
			b:       []float32{1, 2, 3},
			wantMin: -0.01, wantMax: 0.01,
		},
		{
			name:    "zero vector b",
			a:       []float32{1, 2, 3},
			b:       []float32{0, 0, 0},
			wantMin: -0.01, wantMax: 0.01,
		},
		{
			name:    "both zero",
			a:       []float32{0, 0, 0},
			b:       []float32{0, 0, 0},
			wantMin: -0.01, wantMax: 0.01,
		},
		{
			name:    "mismatched lengths",
			a:       []float32{1, 2},
			b:       []float32{1, 2, 3},
			wantMin: -0.01, wantMax: 0.01,
		},
		{
			name:    "empty vectors",
			a:       []float32{},
			b:       []float32{},
			wantMin: -0.01, wantMax: 0.01,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := cosineSimilarity(tt.a, tt.b)
			if got < tt.wantMin || got > tt.wantMax {
				t.Errorf("cosineSimilarity(%v, %v) = %f, want in [%f, %f]", tt.a, tt.b, got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestInsertGetEmbedding(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	vec := []float32{0.1, 0.2, 0.3, 0.4, 0.5}
	if err := st.InsertEmbedding("docs", 42, "voyage-4-large", vec); err != nil {
		t.Fatalf("InsertEmbedding(docs, 42) = %v", err)
	}

	got, err := st.GetEmbedding("docs", 42)
	if err != nil {
		t.Fatalf("GetEmbedding(docs, 42) = _, %v", err)
	}
	if len(got) != len(vec) {
		t.Fatalf("GetEmbedding(docs, 42) length = %d, want %d", len(got), len(vec))
	}
	for i := range vec {
		if got[i] != vec[i] {
			t.Errorf("GetEmbedding(docs, 42)[%d] = %v, want %v", i, got[i], vec[i])
		}
	}

	// Non-existent embedding returns error (sql.ErrNoRows).
	result, err := st.GetEmbedding("docs", 999)
	if err == nil {
		t.Errorf("GetEmbedding(docs, 999) = %v, nil; want _, error", result)
	}

	// Replace existing embedding.
	vec2 := []float32{0.9, 0.8, 0.7}
	if err := st.InsertEmbedding("docs", 42, "voyage-4-large", vec2); err != nil {
		t.Fatalf("InsertEmbedding(docs, 42) replace = %v", err)
	}
	got2, err := st.GetEmbedding("docs", 42)
	if err != nil {
		t.Fatalf("GetEmbedding(docs, 42) after replace = _, %v", err)
	}
	if len(got2) != len(vec2) {
		t.Fatalf("GetEmbedding(docs, 42) after replace length = %d, want %d", len(got2), len(vec2))
	}
}

func TestVectorSearch(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// Insert docs and embeddings. Use directional vectors for predictable similarity.
	type entry struct {
		id  int64
		vec []float32
	}
	entries := []entry{
		{1, []float32{1, 0, 0}},      // points along x
		{2, []float32{0.9, 0.1, 0}},  // mostly x
		{3, []float32{0, 1, 0}},      // points along y (orthogonal to x)
		{4, []float32{-1, 0, 0}},     // opposite of x
	}
	for _, e := range entries {
		_, _, err := st.UpsertDoc(context.Background(), &DocRow{
			URL:         "https://example.com/doc",
			SectionPath: "Section " + string(rune('A'+e.id)),
			Content:     "content",
			SourceType:  "seed",
		})
		if err != nil {
			t.Fatalf("UpsertDoc: %v", err)
		}
		if err := st.InsertEmbedding("docs", e.id, "test", e.vec); err != nil {
			t.Fatalf("InsertEmbedding(%d) = %v", e.id, err)
		}
	}

	// Query along x-axis. Should match entries 1 and 2 (above threshold 0.3),
	// entry 3 is orthogonal (~0), entry 4 is opposite (~-1).
	query := []float32{1, 0, 0}
	results, err := st.VectorSearch(context.Background(),query, "docs", 10)
	if err != nil {
		t.Fatalf("VectorSearch = _, %v", err)
	}
	if len(results) < 2 {
		t.Fatalf("VectorSearch returned %d results, want >= 2", len(results))
	}
	// First result should be entry 1 (exact match, score ~1.0).
	if results[0].SourceID != 1 {
		t.Errorf("VectorSearch top result SourceID = %d, want 1", results[0].SourceID)
	}
	// Results should be sorted descending by score.
	for i := 1; i < len(results); i++ {
		if results[i].Score > results[i-1].Score {
			t.Errorf("VectorSearch results not sorted: [%d].Score=%f > [%d].Score=%f",
				i, results[i].Score, i-1, results[i-1].Score)
		}
	}
	// Orthogonal and opposite should be filtered by minSimilarity.
	for _, r := range results {
		if r.Score < minSimilarity {
			t.Errorf("VectorSearch result SourceID=%d has Score=%f < minSimilarity=%f",
				r.SourceID, r.Score, minSimilarity)
		}
	}

	// Limit results.
	limited, err := st.VectorSearch(context.Background(),query, "docs", 1)
	if err != nil {
		t.Fatalf("VectorSearch(limit=1) = _, %v", err)
	}
	if len(limited) != 1 {
		t.Errorf("VectorSearch(limit=1) returned %d results, want 1", len(limited))
	}

	// Nil queryVec returns nil.
	nilResult, err := st.VectorSearch(context.Background(),nil, "docs", 10)
	if err != nil {
		t.Fatalf("VectorSearch(nil) = _, %v", err)
	}
	if nilResult != nil {
		t.Errorf("VectorSearch(nil) = %v, want nil", nilResult)
	}

	// Non-existent source returns empty.
	empty, err := st.VectorSearch(context.Background(),query, "nonexistent", 10)
	if err != nil {
		t.Fatalf("VectorSearch(nonexistent) = _, %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("VectorSearch(nonexistent) returned %d results, want 0", len(empty))
	}
}

func TestCountEmbeddings(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	n, err := st.CountEmbeddings()
	if err != nil {
		t.Fatalf("CountEmbeddings(empty): %v", err)
	}
	if n != 0 {
		t.Errorf("CountEmbeddings(empty) = %d, want 0", n)
	}

	// Insert some embeddings.
	for i := int64(1); i <= 3; i++ {
		_, _, err := st.UpsertDoc(context.Background(), &DocRow{
			URL: "https://example.com/ce", SectionPath: "S" + string(rune('A'+i)),
			Content: "c", SourceType: "docs",
		})
		if err != nil {
			t.Fatalf("UpsertDoc: %v", err)
		}
		if err := st.InsertEmbedding("docs", i, "test", []float32{float32(i), 0, 0}); err != nil {
			t.Fatalf("InsertEmbedding(%d): %v", i, err)
		}
	}

	n, err = st.CountEmbeddings()
	if err != nil {
		t.Fatalf("CountEmbeddings: %v", err)
	}
	if n != 3 {
		t.Errorf("CountEmbeddings = %d, want 3", n)
	}
}

func TestGetEmbeddingNotFound(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	_, err := st.GetEmbedding("docs", 999)
	if err == nil {
		t.Error("GetEmbedding(nonexistent) should return error")
	}
}

func TestInsertEmbeddingDimensionValidation(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	st.ExpectedDims = 3

	// Correct dimensions.
	err := st.InsertEmbedding("docs", 1, "test", []float32{1, 2, 3})
	if err != nil {
		t.Fatalf("InsertEmbedding(correct dims): %v", err)
	}

	// Wrong dimensions.
	err = st.InsertEmbedding("docs", 2, "test", []float32{1, 2})
	if err == nil {
		t.Error("InsertEmbedding(wrong dims) should return error")
	}
}

func TestFilterByDocSourceType(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert docs of different source types.
	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/f1", SectionPath: "F1", Content: "c1", SourceType: "docs",
	})
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/f2", SectionPath: "F2", Content: "c2", SourceType: "memory",
	})
	id3, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/f3", SectionPath: "F3", Content: "c3", SourceType: "docs",
	})

	candidates := []HybridMatch{
		{DocID: id1, RRFScore: 0.5},
		{DocID: id2, RRFScore: 0.4},
		{DocID: id3, RRFScore: 0.3},
	}

	// Filter to only "docs" type.
	filtered := st.filterByDocSourceType(ctx, candidates, []string{"docs"})
	if len(filtered) != 2 {
		t.Errorf("filterByDocSourceType(docs) = %d results, want 2", len(filtered))
	}

	// Empty candidates.
	empty := st.filterByDocSourceType(ctx, nil, []string{"docs"})
	if len(empty) != 0 {
		t.Errorf("filterByDocSourceType(nil) = %d, want 0", len(empty))
	}

	// Empty types returns all.
	all := st.filterByDocSourceType(ctx, candidates, nil)
	if len(all) != 3 {
		t.Errorf("filterByDocSourceType(nil types) = %d, want 3", len(all))
	}
}

func TestHybridSearch(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// Insert docs with content for FTS and embeddings for vector search.
	docs := []struct {
		url     string
		section string
		content string
		vec     []float32
	}{
		{"https://example.com/hooks", "Hooks", "Hooks allow you to run commands on lifecycle events", []float32{1, 0, 0}},
		{"https://example.com/skills", "Skills", "Skills are prompt templates that guide Claude", []float32{0, 1, 0}},
		{"https://example.com/mcp", "MCP", "MCP servers provide tools and hooks integration", []float32{0.7, 0.7, 0}},
	}

	for i, d := range docs {
		id, _, err := st.UpsertDoc(context.Background(), &DocRow{
			URL:         d.url,
			SectionPath: d.section,
			Content:     d.content,
			SourceType:  "seed",
		})
		if err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
		if err := st.InsertEmbedding("docs", id, "test", d.vec); err != nil {
			t.Fatalf("InsertEmbedding[%d]: %v", i, err)
		}
	}

	// Search with both vector and FTS signals. Query "hooks" with vector close to doc 1.
	queryVec := []float32{0.9, 0.1, 0}
	results, err := st.HybridSearch(context.Background(),queryVec, "hooks", "", 5, 20)
	if err != nil {
		t.Fatalf("HybridSearch = _, %v", err)
	}
	if len(results) == 0 {
		t.Fatal("HybridSearch returned 0 results, want > 0")
	}

	// The hooks doc should rank high because it matches both FTS and vector.
	// Verify RRF scores are positive and sorted descending.
	for i := range results {
		if results[i].RRFScore <= 0 {
			t.Errorf("HybridSearch result[%d] RRFScore=%f, want > 0", i, results[i].RRFScore)
		}
		if i > 0 && results[i].RRFScore > results[i-1].RRFScore {
			t.Errorf("HybridSearch results not sorted: [%d].RRFScore=%f > [%d].RRFScore=%f",
				i, results[i].RRFScore, i-1, results[i-1].RRFScore)
		}
	}

	// FTS-only search (nil vector).
	ftsOnly, err := st.HybridSearch(context.Background(),nil, "hooks", "", 5, 0)
	if err != nil {
		t.Fatalf("HybridSearch(fts-only) = _, %v", err)
	}
	if len(ftsOnly) == 0 {
		t.Fatal("HybridSearch(fts-only) returned 0 results, want > 0")
	}

	// Vector-only search (empty FTS query).
	vecOnly, err := st.HybridSearch(context.Background(),queryVec, "", "", 5, 0)
	if err != nil {
		t.Fatalf("HybridSearch(vec-only) = _, %v", err)
	}
	if len(vecOnly) == 0 {
		t.Fatal("HybridSearch(vec-only) returned 0 results, want > 0")
	}

	// Both nil/empty returns nil.
	empty, err := st.HybridSearch(context.Background(),nil, "", "", 5, 0)
	if err != nil {
		t.Fatalf("HybridSearch(empty) = _, %v", err)
	}
	if empty != nil {
		t.Errorf("HybridSearch(empty) = %v, want nil", empty)
	}
}
