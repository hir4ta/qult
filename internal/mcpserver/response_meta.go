package mcpserver

import (
	"context"
	"encoding/json"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/store"
)

// ResponseMeta provides context about the quality and source of a response.
type ResponseMeta struct {
	Confidence   float64 `json:"confidence,omitempty"`    // 0-1
	Source       string  `json:"source,omitempty"`        // "session" | "project" | "global" | "seed"
	DataMaturity string  `json:"data_maturity,omitempty"` // "learning" | "growing" | "mature"
	SessionCount int     `json:"session_count,omitempty"`
	GeneratedAt  string  `json:"generated_at,omitempty"`  // RFC3339 timestamp
}

// buildResponseMeta creates metadata based on current data maturity.
func buildResponseMeta(st *store.Store, source string) *ResponseMeta {
	meta := &ResponseMeta{
		Source:      source,
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
	}

	if st == nil {
		meta.DataMaturity = "learning"
		meta.Confidence = 0.3
		return meta
	}

	sessionCount := 0
	if stats, err := st.GetProjectSessionStats(""); err == nil && stats != nil {
		sessionCount = stats.TotalSessions
	}
	meta.SessionCount = sessionCount

	patternCount, _ := st.CountPatterns()

	switch {
	case sessionCount < 3:
		meta.DataMaturity = "learning"
		meta.Confidence = 0.3 + 0.1*float64(sessionCount)
	case patternCount < 10:
		meta.DataMaturity = "growing"
		meta.Confidence = 0.6 + 0.02*float64(patternCount)
	default:
		meta.DataMaturity = "mature"
		meta.Confidence = 0.8 + min(0.2, 0.005*float64(patternCount))
	}

	return meta
}

// withMetaHandler wraps a handler to inject _meta into JSON responses.
func withMetaHandler(h server.ToolHandlerFunc, st *store.Store, source string) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		result, err := h(ctx, req)
		if err != nil || result == nil || result.IsError {
			return result, err
		}
		if len(result.Content) == 0 {
			return result, nil
		}

		tc, ok := result.Content[0].(mcp.TextContent)
		if !ok || tc.Text == "" {
			return result, nil
		}

		// Try to parse as JSON object.
		var obj map[string]any
		if jsonErr := json.Unmarshal([]byte(tc.Text), &obj); jsonErr != nil {
			return result, nil
		}

		obj["_meta"] = buildResponseMeta(st, source)

		data, jsonErr := json.MarshalIndent(obj, "", "  ")
		if jsonErr != nil {
			return result, nil
		}

		return mcp.NewToolResultText(string(data)), nil
	}
}
