package embedder

import (
	"context"
	"fmt"
	"os"
)

// Embedder wraps a Voyage client for embedding and reranking operations.
// VOYAGE_API_KEY is required; NewEmbedder returns an error if unset.
type Embedder struct {
	client *voyageClient
}

// NewEmbedder creates an Embedder that reads the Voyage API key from VOYAGE_API_KEY.
// Returns an error if the key is not set.
func NewEmbedder() (*Embedder, error) {
	apiKey := os.Getenv("VOYAGE_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("VOYAGE_API_KEY is required but not set")
	}
	return &Embedder{
		client: newVoyageClient(apiKey),
	}, nil
}

// Dims returns the embedding dimensions.
func (e *Embedder) Dims() int {
	return voyageDims
}

// Model returns the model name.
func (e *Embedder) Model() string {
	return voyageModel
}

// EmbedForSearch generates a search query embedding.
func (e *Embedder) EmbedForSearch(ctx context.Context, query string) ([]float32, error) {
	return e.client.embedForSearch(ctx, query)
}

// EmbedForStorage generates a document embedding.
func (e *Embedder) EmbedForStorage(ctx context.Context, text string) ([]float32, error) {
	return e.client.embedForStorage(ctx, text)
}

// EmbedBatchForStorage generates document embeddings for multiple texts in a single API call.
func (e *Embedder) EmbedBatchForStorage(ctx context.Context, texts []string) ([][]float32, error) {
	return e.client.embed(ctx, texts, "document")
}

// Rerank reorders documents by relevance to the query using the Voyage rerank API.
// Returns results sorted by descending relevance score.
func (e *Embedder) Rerank(ctx context.Context, query string, documents []string, topK int) ([]RerankResult, error) {
	return e.client.rerank(ctx, query, documents, topK)
}
