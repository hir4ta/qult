package embedder

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
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

func newTestClient(t *testing.T, handler http.HandlerFunc) *voyageClient {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := newVoyageClient("test-key")
	c.httpClient.Transport = &rewriteTransport{base: srv.URL}
	return c
}

func TestNewEmbedder_NoKey(t *testing.T) {
	t.Setenv("VOYAGE_API_KEY", "")
	_, err := NewEmbedder()
	if err == nil {
		t.Fatal("NewEmbedder() with empty key should return error")
	}
}

func TestNewEmbedder_WithKey(t *testing.T) {
	t.Setenv("VOYAGE_API_KEY", "test-key-123")
	e, err := NewEmbedder()
	if err != nil {
		t.Fatalf("NewEmbedder() error: %v", err)
	}
	if e.Dims() != 1024 {
		t.Errorf("Dims() = %d, want 1024", e.Dims())
	}
	if e.Model() != "voyage-4-large" {
		t.Errorf("Model() = %q, want %q", e.Model(), "voyage-4-large")
	}
}

func TestEmbed(t *testing.T) {
	t.Parallel()

	handler := func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		var req voyageRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		resp := voyageResponse{}
		for range req.Input {
			vec := make([]float32, 4) // small dims for testing
			for i := range vec {
				vec[i] = 0.25
			}
			resp.Data = append(resp.Data, struct {
				Embedding []float32 `json:"embedding"`
			}{Embedding: vec})
		}
		resp.Usage.TotalTokens = 10

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}

	c := newTestClient(t, handler)
	vecs, err := c.embed(context.Background(), []string{"hello", "world"}, "document")
	if err != nil {
		t.Fatalf("embed() error: %v", err)
	}
	if len(vecs) != 2 {
		t.Fatalf("embed() returned %d vectors, want 2", len(vecs))
	}
	if len(vecs[0]) != 4 {
		t.Errorf("embed() vector dims = %d, want 4", len(vecs[0]))
	}
}

func TestEmbed_APIError(t *testing.T) {
	t.Parallel()

	handler := func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}

	c := newTestClient(t, handler)
	_, err := c.embed(context.Background(), []string{"hello"}, "document")
	if err == nil {
		t.Fatal("embed() with 500 response should return error")
	}
}

func TestEmbed_ErrorDetail(t *testing.T) {
	t.Parallel()

	handler := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(voyageErrorResponse{Detail: "invalid input"})
	}

	c := newTestClient(t, handler)
	_, err := c.embed(context.Background(), []string{"hello"}, "document")
	if err == nil {
		t.Fatal("embed() with error detail should return error")
	}
	// Error message should contain the detail from the API response
	if got := err.Error(); !strings.Contains(got, "invalid input") {
		t.Errorf("error message %q should contain %q", got, "invalid input")
	}
}

func TestEmbedForSearch(t *testing.T) {
	t.Parallel()

	handler := func(w http.ResponseWriter, r *http.Request) {
		var req voyageRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.InputType != "query" {
			t.Errorf("input_type = %q, want %q", req.InputType, "query")
		}

		resp := voyageResponse{
			Data: []struct {
				Embedding []float32 `json:"embedding"`
			}{{Embedding: []float32{0.1, 0.2, 0.3}}},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}

	c := newTestClient(t, handler)
	vec, err := c.embedForSearch(context.Background(), "test query")
	if err != nil {
		t.Fatalf("embedForSearch() error: %v", err)
	}
	if len(vec) != 3 {
		t.Errorf("embedForSearch() vector dims = %d, want 3", len(vec))
	}
}

func TestEmbedForStorage(t *testing.T) {
	t.Parallel()

	handler := func(w http.ResponseWriter, r *http.Request) {
		var req voyageRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.InputType != "document" {
			t.Errorf("input_type = %q, want %q", req.InputType, "document")
		}

		resp := voyageResponse{
			Data: []struct {
				Embedding []float32 `json:"embedding"`
			}{{Embedding: []float32{0.4, 0.5, 0.6}}},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}

	c := newTestClient(t, handler)
	vec, err := c.embedForStorage(context.Background(), "test document")
	if err != nil {
		t.Fatalf("embedForStorage() error: %v", err)
	}
	if len(vec) != 3 {
		t.Errorf("embedForStorage() vector dims = %d, want 3", len(vec))
	}
}

func TestRerank(t *testing.T) {
	t.Parallel()

	handler := func(w http.ResponseWriter, r *http.Request) {
		var req rerankRequest
		json.NewDecoder(r.Body).Decode(&req)
		if req.TopK != 2 {
			t.Errorf("top_k = %d, want 2", req.TopK)
		}

		resp := rerankResponse{
			Data: []RerankResult{
				{Index: 1, RelevanceScore: 0.95},
				{Index: 0, RelevanceScore: 0.72},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}

	c := newTestClient(t, handler)
	results, err := c.rerank(context.Background(), "query", []string{"doc A", "doc B"}, 2)
	if err != nil {
		t.Fatalf("rerank() error: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("rerank() returned %d results, want 2", len(results))
	}
	if results[0].Index != 1 {
		t.Errorf("results[0].Index = %d, want 1", results[0].Index)
	}
	if results[0].RelevanceScore != 0.95 {
		t.Errorf("results[0].RelevanceScore = %f, want 0.95", results[0].RelevanceScore)
	}
}

func TestRerank_APIError(t *testing.T) {
	t.Parallel()

	handler := func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}

	c := newTestClient(t, handler)
	_, err := c.rerank(context.Background(), "query", []string{"doc"}, 1)
	if err == nil {
		t.Fatal("rerank() with 503 response should return error")
	}
}

// newTestEmbedder creates an Embedder with a mocked HTTP client for testing.
func newTestEmbedder(t *testing.T, handler http.HandlerFunc) *Embedder {
	t.Helper()
	c := newTestClient(t, handler)
	return &Embedder{client: c}
}

func embedHandler(w http.ResponseWriter, r *http.Request) {
	var req voyageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	resp := voyageResponse{}
	for range req.Input {
		resp.Data = append(resp.Data, struct {
			Embedding []float32 `json:"embedding"`
		}{Embedding: []float32{0.1, 0.2, 0.3}})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func TestEmbedder_EmbedForSearch(t *testing.T) {
	t.Parallel()
	e := newTestEmbedder(t, embedHandler)
	vec, err := e.EmbedForSearch(context.Background(), "test query")
	if err != nil {
		t.Fatalf("EmbedForSearch() error: %v", err)
	}
	if len(vec) != 3 {
		t.Errorf("EmbedForSearch() dims = %d, want 3", len(vec))
	}
}

func TestEmbedder_EmbedForStorage(t *testing.T) {
	t.Parallel()
	e := newTestEmbedder(t, embedHandler)
	vec, err := e.EmbedForStorage(context.Background(), "test doc")
	if err != nil {
		t.Fatalf("EmbedForStorage() error: %v", err)
	}
	if len(vec) != 3 {
		t.Errorf("EmbedForStorage() dims = %d, want 3", len(vec))
	}
}

func TestEmbedder_EmbedBatchForStorage(t *testing.T) {
	t.Parallel()
	e := newTestEmbedder(t, embedHandler)
	vecs, err := e.EmbedBatchForStorage(context.Background(), []string{"doc1", "doc2"})
	if err != nil {
		t.Fatalf("EmbedBatchForStorage() error: %v", err)
	}
	if len(vecs) != 2 {
		t.Errorf("EmbedBatchForStorage() returned %d vecs, want 2", len(vecs))
	}
}

func TestEmbedder_Rerank(t *testing.T) {
	t.Parallel()
	handler := func(w http.ResponseWriter, r *http.Request) {
		resp := rerankResponse{
			Data: []RerankResult{
				{Index: 0, RelevanceScore: 0.9},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
	e := newTestEmbedder(t, handler)
	results, err := e.Rerank(context.Background(), "query", []string{"doc"}, 1)
	if err != nil {
		t.Fatalf("Rerank() error: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("Rerank() returned %d results, want 1", len(results))
	}
}

func TestRerank_ErrorDetail(t *testing.T) {
	t.Parallel()

	handler := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(voyageErrorResponse{Detail: "bad rerank"})
	}

	c := newTestClient(t, handler)
	_, err := c.rerank(context.Background(), "query", []string{"doc"}, 1)
	if err == nil {
		t.Fatal("rerank() with error detail should return error")
	}
	if !strings.Contains(err.Error(), "bad rerank") {
		t.Errorf("error %q should contain 'bad rerank'", err.Error())
	}
}
