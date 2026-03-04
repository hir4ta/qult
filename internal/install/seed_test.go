package install

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// rewriteTransport redirects all requests to a test server.
type rewriteTransport struct {
	base string
}

func (rt *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	target, _ := url.Parse(rt.base + req.URL.Path)
	req.URL = target
	return http.DefaultTransport.RoundTrip(req)
}

func openTestStore(t *testing.T) *store.Store {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func newTestEmbedder(t *testing.T) *embedder.Embedder {
	t.Helper()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Input []string `json:"input"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		type embData struct {
			Embedding []float32 `json:"embedding"`
		}
		resp := struct {
			Data  []embData `json:"data"`
			Usage struct {
				TotalTokens int `json:"total_tokens"`
			} `json:"usage"`
		}{}
		for range req.Input {
			resp.Data = append(resp.Data, embData{Embedding: []float32{0.1, 0.2, 0.3}})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	// Set env var before creating embedder (must not be in a parallel subtest).
	origKey := os.Getenv("VOYAGE_API_KEY")
	os.Setenv("VOYAGE_API_KEY", "test-key")
	t.Cleanup(func() {
		if origKey == "" {
			os.Unsetenv("VOYAGE_API_KEY")
		} else {
			os.Setenv("VOYAGE_API_KEY", origKey)
		}
	})

	emb, err := embedder.NewEmbedder()
	if err != nil {
		t.Fatalf("NewEmbedder: %v", err)
	}
	embedder.SetTestTransport(emb, &rewriteTransport{base: srv.URL})
	return emb
}

func TestApplySeedData(t *testing.T) {
	// Not parallel: newTestEmbedder modifies VOYAGE_API_KEY env var.

	t.Run("nil embedder returns error", func(t *testing.T) {
		_, err := ApplySeedData(context.TODO(), nil, nil, &SeedFile{}, nil)
		if err == nil {
			t.Fatal("expected error for nil embedder")
		}
	})

	t.Run("nil seed file returns zero", func(t *testing.T) {
		st := openTestStore(t)
		emb := newTestEmbedder(t)
		res, err := ApplySeedData(context.TODO(), st, emb, nil, nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.Applied != 0 {
			t.Errorf("Applied = %d, want 0", res.Applied)
		}
	})

	t.Run("empty sources returns zero", func(t *testing.T) {
		st := openTestStore(t)
		emb := newTestEmbedder(t)
		res, err := ApplySeedData(context.TODO(), st, emb, &SeedFile{Sources: nil}, nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.Applied != 0 {
			t.Errorf("Applied = %d, want 0", res.Applied)
		}
	})

	t.Run("applies and embeds docs", func(t *testing.T) {
		st := openTestStore(t)
		emb := newTestEmbedder(t)

		sf := &SeedFile{
			CrawledAt: "2025-01-01T00:00:00Z",
			Sources: []SeedSource{
				{
					URL:        "https://example.com/docs",
					SourceType: "seed",
					Sections: []SeedSection{
						{Path: "Section A", Content: "Content A"},
						{Path: "Section B", Content: "Content B"},
					},
				},
			},
		}

		var docDone, embedDone int
		progress := &SeedProgress{
			OnDocUpsert:  func(done, total int) { docDone = done },
			OnEmbedBatch: func(done, total int) { embedDone = done },
		}

		res, err := ApplySeedData(context.TODO(), st, emb, sf, progress)
		if err != nil {
			t.Fatalf("ApplySeedData error: %v", err)
		}
		if res.Applied != 2 {
			t.Errorf("Applied = %d, want 2", res.Applied)
		}
		if res.Embedded != 2 {
			t.Errorf("Embedded = %d, want 2", res.Embedded)
		}
		if docDone != 2 {
			t.Errorf("docDone = %d, want 2", docDone)
		}
		if embedDone != 2 {
			t.Errorf("embedDone = %d, want 2", embedDone)
		}

		// Run again — should be unchanged.
		res2, err := ApplySeedData(context.TODO(), st, emb, sf, nil)
		if err != nil {
			t.Fatalf("ApplySeedData (2nd) error: %v", err)
		}
		if res2.Unchanged != 2 {
			t.Errorf("Unchanged = %d, want 2", res2.Unchanged)
		}
		if res2.Embedded != 0 {
			t.Errorf("Embedded (2nd) = %d, want 0", res2.Embedded)
		}
	})
}
