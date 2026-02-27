package embedder

import (
	"context"
	"os"
	"sync"
)

// Embedder wraps a Voyage client with availability state.
// When no API key is configured, all operations gracefully degrade (Available() returns false).
type Embedder struct {
	client    *voyageClient
	available bool
	mu        sync.RWMutex
}

// NewEmbedder creates an Embedder that reads the Voyage API key from VOYAGE_API_KEY.
// If the key is empty, the embedder is inert — Available() will always return false.
func NewEmbedder() *Embedder {
	apiKey := os.Getenv("VOYAGE_API_KEY")
	if apiKey == "" {
		return &Embedder{}
	}
	return &Embedder{
		client: newVoyageClient(apiKey),
	}
}

// EnsureAvailable checks Voyage API availability and caches the result.
func (e *Embedder) EnsureAvailable(ctx context.Context) bool {
	if e.client == nil {
		return false
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	if e.available {
		return true
	}

	if e.client.isAvailable(ctx) {
		e.available = true
	}
	return e.available
}

// Available returns the cached availability status.
func (e *Embedder) Available() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.available
}

// Dims returns the embedding dimensions (fixed for voyage-3.5).
func (e *Embedder) Dims() int {
	return voyageDims
}

// Model returns the model name.
func (e *Embedder) Model() string {
	return voyageModel
}

// EmbedBatch generates embeddings for multiple texts.
func (e *Embedder) EmbedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	if e.client == nil {
		return nil, nil
	}
	return e.client.embed(ctx, texts, "document")
}

// EmbedForSearch generates a search query embedding.
func (e *Embedder) EmbedForSearch(ctx context.Context, query string) ([]float32, error) {
	if e.client == nil {
		return nil, nil
	}
	return e.client.embedForSearch(ctx, query)
}

// EmbedForStorage generates a document embedding.
func (e *Embedder) EmbedForStorage(ctx context.Context, text string) ([]float32, error) {
	if e.client == nil {
		return nil, nil
	}
	return e.client.embedForStorage(ctx, text)
}
