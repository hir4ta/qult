package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const DefaultBaseURL = "http://localhost:11434"

// Client is an HTTP client for the Ollama API.
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// NewClient creates a new Ollama client.
func NewClient(baseURL string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// GenerateRequest is the request body for /api/generate.
type GenerateRequest struct {
	Model   string         `json:"model"`
	Prompt  string         `json:"prompt"`
	System  string         `json:"system,omitempty"`
	Stream  bool           `json:"stream"`
	Format  map[string]any `json:"format,omitempty"`
	Options map[string]any `json:"options,omitempty"`

	// KeepAlive controls how long the model stays loaded.
	// Use -1 for indefinite, "5m" for 5 minutes, etc.
	KeepAlive any `json:"keep_alive,omitempty"`
}

// GenerateResponse is the response body from /api/generate (non-streaming).
type GenerateResponse struct {
	Model    string `json:"model"`
	Response string `json:"response"`
	Done     bool   `json:"done"`

	// Timing fields (nanoseconds).
	TotalDuration      int64 `json:"total_duration"`
	LoadDuration       int64 `json:"load_duration"`
	PromptEvalCount    int   `json:"prompt_eval_count"`
	PromptEvalDuration int64 `json:"prompt_eval_duration"`
	EvalCount          int   `json:"eval_count"`
	EvalDuration       int64 `json:"eval_duration"`
}

// Generate calls /api/generate with non-streaming mode.
func (c *Client) Generate(ctx context.Context, req *GenerateRequest) (*GenerateResponse, error) {
	req.Stream = false

	payload, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("ollama: marshal: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/api/generate", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("ollama: new request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("ollama: request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ollama: status %d: %s", resp.StatusCode, string(body))
	}

	var result GenerateResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("ollama: decode: %w", err)
	}

	return &result, nil
}

// Warmup sends a minimal request to keep the model loaded in memory.
func (c *Client) Warmup(ctx context.Context, model string) error {
	req := &GenerateRequest{
		Model:     model,
		Prompt:    "",
		KeepAlive: -1,
		Options:   map[string]any{"num_predict": 1},
	}
	_, err := c.Generate(ctx, req)
	return err
}

// IsAvailable checks if Ollama is running.
func (c *Client) IsAvailable(ctx context.Context) bool {
	httpReq, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/api/tags", nil)
	if err != nil {
		return false
	}
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

// HasModel checks if a specific model is available.
func (c *Client) HasModel(ctx context.Context, model string) bool {
	httpReq, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/api/tags", nil)
	if err != nil {
		return false
	}
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	var result struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false
	}
	if json.Unmarshal(body, &result) != nil {
		return false
	}
	for _, m := range result.Models {
		if m.Name == model || m.Name == model+":latest" {
			return true
		}
	}
	return false
}
