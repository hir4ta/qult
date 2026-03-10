package embedder

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"strconv"
	"time"
)

// Defaults for Voyage AI API. Override with environment variables:
//
//	VOYAGE_API_URL        — embedding endpoint (default: https://api.voyageai.com/v1/embeddings)
//	VOYAGE_RERANK_API_URL — rerank endpoint   (default: https://api.voyageai.com/v1/rerank)
//	VOYAGE_MODEL          — embedding model   (default: voyage-4-large)
//	VOYAGE_RERANK_MODEL   — rerank model      (default: rerank-2.5)
//	VOYAGE_DIMS           — output dimensions  (default: 2048)
const (
	defaultVoyageAPI       = "https://api.voyageai.com/v1/embeddings"
	defaultVoyageRerankAPI = "https://api.voyageai.com/v1/rerank"
	defaultVoyageModel     = "voyage-4-large"
	defaultVoyageRerankMod = "rerank-2.5"
	defaultVoyageDims      = 2048
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

// voyageClient is an HTTP client for the Voyage AI embedding API.
type voyageClient struct {
	apiKey      string
	httpClient  *http.Client
	apiURL      string
	rerankURL   string
	model       string
	rerankModel string
	dims        int
}

func newVoyageClient(apiKey string) *voyageClient {
	return &voyageClient{
		apiKey:      apiKey,
		apiURL:      envOr("VOYAGE_API_URL", defaultVoyageAPI),
		rerankURL:   envOr("VOYAGE_RERANK_API_URL", defaultVoyageRerankAPI),
		model:       envOr("VOYAGE_MODEL", defaultVoyageModel),
		rerankModel: envOr("VOYAGE_RERANK_MODEL", defaultVoyageRerankMod),
		dims:        envIntOr("VOYAGE_DIMS", defaultVoyageDims),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

type voyageRequest struct {
	Input           []string `json:"input"`
	Model           string   `json:"model"`
	InputType       string   `json:"input_type,omitempty"`
	OutputDimension int      `json:"output_dimension,omitempty"`
}

type voyageResponse struct {
	Data []struct {
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Usage struct {
		TotalTokens int `json:"total_tokens"`
	} `json:"usage"`
}

type voyageErrorResponse struct {
	Detail string `json:"detail"`
}

// voyageError wraps a Voyage API error with status code for retry decisions.
type voyageError struct {
	status int
	detail string
	raw    string // full response body for debugging
}

func (e *voyageError) Error() string {
	// Mask raw body for auth errors to prevent API key leakage in logs.
	if e.status == 401 || e.status == 403 {
		return fmt.Sprintf("embedder: voyage returned %d: authentication failed (check VOYAGE_API_KEY, run 'alfred settings' to reconfigure)", e.status)
	}
	if e.raw != "" && e.raw != e.detail {
		return fmt.Sprintf("embedder: voyage returned %d: %s (raw: %s)", e.status, e.detail, e.raw)
	}
	return fmt.Sprintf("embedder: voyage returned %d: %s", e.status, e.detail)
}

// isVoyageTransient reports whether a 400-status error detail indicates a transient
// Voyage-side model failure (e.g. "Request to model ... failed") rather than a
// client validation error. Uses multiple patterns for resilience against API wording changes.
func isVoyageTransient(detail string) bool {
	lower := strings.ToLower(detail)
	for _, pattern := range []string{
		"request to model",    // current Voyage transient error pattern
		"model is overloaded", // potential future pattern
		"temporarily",         // generic transient indicator
		"try again",           // generic retry suggestion
		"service unavailable",  // generic 503-like in body
		"internal server error", // server-side failure (scoped to avoid matching client validation errors)
		"over capacity",        // capacity-related transient failures
	} {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

// retryVoyage retries fn up to 3 times with exponential backoff on transient errors.
// Retries on 429, 5xx, transient 400s, and non-Voyage errors (network, DNS, TLS).
// Returns immediately on non-retryable errors (401, 403, 404, 422, etc.).
func retryVoyage[T any](ctx context.Context, fn func() (T, error)) (T, error) {
	var lastErr error
	var zero T
	for attempt := range 3 {
		if attempt > 0 {
			delay := time.Duration(1<<attempt) * time.Second
			select {
			case <-ctx.Done():
				return zero, ctx.Err()
			case <-time.After(delay):
			}
		}
		result, err := fn()
		if err == nil {
			return result, nil
		}
		lastErr = err
		var ve *voyageError
		if errors.As(err, &ve) {
			switch {
			case ve.status == 429, ve.status >= 500:
				continue
			case ve.status == 400 && isVoyageTransient(ve.detail):
				continue
			default:
				return zero, err
			}
		}
		continue
	}
	return zero, lastErr
}

// embed sends an embedding request to the Voyage API with retry on transient errors.
func (c *voyageClient) embed(ctx context.Context, texts []string, inputType string) ([][]float32, error) {
	payload, err := json.Marshal(voyageRequest{
		Input:           texts,
		Model:           c.model,
		InputType:       inputType,
		OutputDimension: c.dims,
	})
	if err != nil {
		return nil, fmt.Errorf("embedder: marshal: %w", err)
	}
	return retryVoyage(ctx, func() ([][]float32, error) {
		return c.doEmbed(ctx, payload)
	})
}

func (c *voyageClient) doEmbed(ctx context.Context, payload []byte) ([][]float32, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", c.apiURL, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("embedder: new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embedder: request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10)) // 64 KB cap for error responses
		raw := string(respBody)
		var errResp voyageErrorResponse
		if json.Unmarshal(respBody, &errResp) == nil && errResp.Detail != "" {
			return nil, &voyageError{status: resp.StatusCode, detail: errResp.Detail, raw: raw}
		}
		return nil, &voyageError{status: resp.StatusCode, detail: raw, raw: raw}
	}

	var result voyageResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("embedder: decode response: %w", err)
	}

	vecs := make([][]float32, len(result.Data))
	for i, d := range result.Data {
		vecs[i] = d.Embedding
	}
	return vecs, nil
}

// embedForSearch generates an embedding for a search query.
func (c *voyageClient) embedForSearch(ctx context.Context, query string) ([]float32, error) {
	vecs, err := c.embed(ctx, []string{query}, "query")
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 {
		return nil, fmt.Errorf("embedder: no embeddings returned")
	}
	return vecs[0], nil
}

// embedForStorage generates an embedding for storing a document.
func (c *voyageClient) embedForStorage(ctx context.Context, text string) ([]float32, error) {
	vecs, err := c.embed(ctx, []string{text}, "document")
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 {
		return nil, fmt.Errorf("embedder: no embeddings returned")
	}
	return vecs[0], nil
}

// rerankRequest is the payload for the Voyage rerank API.
type rerankRequest struct {
	Query           string   `json:"query"`
	Documents       []string `json:"documents"`
	Model           string   `json:"model"`
	TopK            int      `json:"top_k,omitempty"`
	ReturnDocuments bool     `json:"return_documents"`
}

// rerankResponse is the response from the Voyage rerank API.
type rerankResponse struct {
	Data []RerankResult `json:"data"`
}

// RerankResult is one reranked document with its relevance score.
type RerankResult struct {
	Index          int     `json:"index"`
	RelevanceScore float64 `json:"relevance_score"`
}

// rerank calls the Voyage rerank API with retry on transient errors.
func (c *voyageClient) rerank(ctx context.Context, query string, documents []string, topK int) ([]RerankResult, error) {
	payload, err := json.Marshal(rerankRequest{
		Query:     query,
		Documents: documents,
		Model:     c.rerankModel,
		TopK:      topK,
	})
	if err != nil {
		return nil, fmt.Errorf("embedder: marshal rerank: %w", err)
	}
	return retryVoyage(ctx, func() ([]RerankResult, error) {
		return c.doRerank(ctx, payload)
	})
}

// doRerank performs a single rerank API request.
func (c *voyageClient) doRerank(ctx context.Context, payload []byte) ([]RerankResult, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", c.rerankURL, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("embedder: new rerank request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embedder: rerank request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10)) // 64 KB cap for error responses
		raw := string(respBody)
		var errResp voyageErrorResponse
		if json.Unmarshal(respBody, &errResp) == nil && errResp.Detail != "" {
			return nil, &voyageError{status: resp.StatusCode, detail: errResp.Detail, raw: raw}
		}
		return nil, &voyageError{status: resp.StatusCode, detail: raw, raw: raw}
	}

	var result rerankResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("embedder: decode rerank response: %w", err)
	}
	return result.Data, nil
}
