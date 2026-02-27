package embedder

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	voyageAPI   = "https://api.voyageai.com/v1/embeddings"
	voyageModel = "voyage-4-large"
	voyageDims  = 2048
)

// voyageClient is an HTTP client for the Voyage AI embedding API.
type voyageClient struct {
	apiKey     string
	httpClient *http.Client
}

func newVoyageClient(apiKey string) *voyageClient {
	return &voyageClient{
		apiKey: apiKey,
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

// embed sends an embedding request to the Voyage API.
func (c *voyageClient) embed(ctx context.Context, texts []string, inputType string) ([][]float32, error) {
	body := voyageRequest{
		Input:           texts,
		Model:           voyageModel,
		InputType:       inputType,
		OutputDimension: voyageDims,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("embedder: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", voyageAPI, bytes.NewReader(payload))
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
		respBody, _ := io.ReadAll(resp.Body)
		var errResp voyageErrorResponse
		if json.Unmarshal(respBody, &errResp) == nil && errResp.Detail != "" {
			return nil, fmt.Errorf("embedder: voyage returned %d: %s", resp.StatusCode, errResp.Detail)
		}
		return nil, fmt.Errorf("embedder: voyage returned %d: %s", resp.StatusCode, string(respBody))
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

// isAvailable checks if the Voyage API is reachable with a minimal request.
func (c *voyageClient) isAvailable(ctx context.Context) bool {
	_, err := c.embed(ctx, []string{"test"}, "document")
	return err == nil
}
