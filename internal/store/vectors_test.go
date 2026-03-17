package store

import (
	"math"
	"testing"
)

func TestSerializeDeserializeFloat32(t *testing.T) {
	t.Parallel()
	original := []float32{1.0, -2.5, 3.14, 0.0, -0.001}
	blob := serializeFloat32(original)

	if len(blob) != len(original)*4 {
		t.Fatalf("blob size = %d, want %d", len(blob), len(original)*4)
	}

	recovered := deserializeFloat32(blob)
	if len(recovered) != len(original) {
		t.Fatalf("recovered length = %d, want %d", len(recovered), len(original))
	}
	for i, v := range original {
		if recovered[i] != v {
			t.Errorf("recovered[%d] = %f, want %f", i, recovered[i], v)
		}
	}
}

func TestCosineSimilarity(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		a, b []float32
		want float64
	}{
		{"identical", []float32{1, 0, 0}, []float32{1, 0, 0}, 1.0},
		{"orthogonal", []float32{1, 0, 0}, []float32{0, 1, 0}, 0.0},
		{"opposite", []float32{1, 0, 0}, []float32{-1, 0, 0}, -1.0},
		{"empty", nil, nil, 0.0},
		{"length mismatch", []float32{1}, []float32{1, 2}, 0.0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := cosineSimilarity(tc.a, tc.b)
			if math.Abs(got-tc.want) > 0.001 {
				t.Errorf("cosineSimilarity = %f, want %f", got, tc.want)
			}
		})
	}
}

func TestInsertAndSearchEmbedding(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := t.Context()

	id, _, err := st.UpsertKnowledge(ctx, &KnowledgeRow{
		FilePath:    "decisions/dec-001.md",
		Title:       "Test decision",
		Content:     "Use vector search for semantic matching",
		SubType:     SubTypeDecision,
		ProjectPath: "/test",
	})
	if err != nil {
		t.Fatalf("UpsertKnowledge: %v", err)
	}

	vec := []float32{0.1, 0.2, 0.3, 0.4}
	if err := st.InsertEmbedding("knowledge", id, "test-model", vec); err != nil {
		t.Fatalf("InsertEmbedding: %v", err)
	}

	results, err := st.VectorSearchKnowledge(ctx, vec, 5)
	if err != nil {
		t.Fatalf("VectorSearchKnowledge: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected at least 1 result")
	}
	if results[0].SourceID != id {
		t.Errorf("SourceID = %d, want %d", results[0].SourceID, id)
	}
	if results[0].Score < 0.99 {
		t.Errorf("self-similarity = %f, want ~1.0", results[0].Score)
	}
}

func TestCleanOrphanedEmbeddings(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	if err := st.InsertEmbedding("knowledge", 99999, "test-model", []float32{0.1, 0.2}); err != nil {
		t.Fatalf("InsertEmbedding: %v", err)
	}

	cleaned, err := st.CleanOrphanedEmbeddings()
	if err != nil {
		t.Fatalf("CleanOrphanedEmbeddings: %v", err)
	}
	if cleaned != 1 {
		t.Errorf("cleaned = %d, want 1", cleaned)
	}
}
