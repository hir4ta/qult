package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// ResponseMeta provides context about the quality and source of a response.
type ResponseMeta struct {
	Confidence       float64 `json:"confidence,omitempty"`          // 0-1
	Source           string  `json:"source,omitempty"`              // "session" | "project" | "global" | "seed"
	DataMaturity     string  `json:"data_maturity,omitempty"`       // "learning" | "growing" | "mature"
	DataMaturityNote string  `json:"data_maturity_note,omitempty"`  // human-readable maturity explanation
	SessionCount     int     `json:"session_count,omitempty"`
	SchemaVersion    int     `json:"schema_version,omitempty"`      // current DB schema version
	Format           string  `json:"format,omitempty"`              // "concise" when concise mode is active
	GeneratedAt      string  `json:"generated_at,omitempty"`        // RFC3339 timestamp
}

// buildResponseMeta creates metadata based on current data maturity.
func buildResponseMeta(st *store.Store, source string) *ResponseMeta {
	meta := &ResponseMeta{
		Source:        source,
		SchemaVersion: store.SchemaVersion(),
		GeneratedAt:   time.Now().UTC().Format(time.RFC3339),
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

	patternCount := 0 // patterns table removed in alfred v1

	switch {
	case sessionCount < 3:
		meta.DataMaturity = "learning"
		meta.DataMaturityNote = "Limited data (< 3 sessions). Recommendations will improve with usage."
		meta.Confidence = 0.3 + 0.1*float64(sessionCount)
	case patternCount < 10:
		meta.DataMaturity = "growing"
		meta.DataMaturityNote = "Building profile (3-10 sessions). Core patterns established."
		meta.Confidence = 0.6 + 0.02*float64(patternCount)
	default:
		meta.DataMaturity = "mature"
		meta.DataMaturityNote = "Rich data available. Recommendations are personalized."
		meta.Confidence = 0.8 + min(0.2, 0.005*float64(patternCount))
	}

	return meta
}

// withMetaHandler wraps a handler to inject _meta into JSON responses.
// When the request contains format=concise, the response is condensed to
// a summary string + key scalar values to reduce token consumption.
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

		meta := buildResponseMeta(st, source)

		// Check for concise format request.
		format, _ := req.GetArguments()["format"].(string)
		if format == "concise" {
			obj = formatConcise(obj)
			meta.Format = "concise"
		}

		obj["_meta"] = meta

		data, jsonErr := json.MarshalIndent(obj, "", "  ")
		if jsonErr != nil {
			return result, nil
		}

		return mcp.NewToolResultText(string(data)), nil
	}
}

// formatConcise reduces a full JSON response to summary + key_data.
// Scalar values (string, number, bool) are kept in key_data.
// Arrays and objects are summarized by count or omitted.
func formatConcise(obj map[string]any) map[string]any {
	keyData := make(map[string]any)
	var summaryParts []string

	for k, v := range obj {
		if k == "_meta" {
			continue
		}
		switch val := v.(type) {
		case float64:
			keyData[k] = val
		case bool:
			keyData[k] = val
		case string:
			if len(val) <= 100 {
				keyData[k] = val
			} else {
				keyData[k] = val[:97] + "..."
			}
		case []any:
			keyData[k+"_count"] = len(val)
		case map[string]any:
			// Flatten small nested objects (≤ 4 scalar fields).
			scalars := 0
			for _, sv := range val {
				switch sv.(type) {
				case float64, bool, string:
					scalars++
				}
			}
			if scalars <= 4 && scalars == len(val) {
				keyData[k] = val
			} else {
				keyData[k+"_keys"] = len(val)
			}
		}
	}

	// Build summary from common fields.
	if h, ok := keyData["health"].(float64); ok {
		summaryParts = append(summaryParts, fmt.Sprintf("health=%.2f", h))
	}
	if p, ok := keyData["phase"].(string); ok {
		summaryParts = append(summaryParts, "phase="+p)
	}
	if t, ok := keyData["total_tools"].(float64); ok {
		summaryParts = append(summaryParts, fmt.Sprintf("tools=%.0f", t))
	}
	if e, ok := keyData["total_errors"].(float64); ok && e > 0 {
		summaryParts = append(summaryParts, fmt.Sprintf("errors=%.0f", e))
	}
	if s, ok := keyData["snr"].(float64); ok {
		summaryParts = append(summaryParts, fmt.Sprintf("snr=%.2f", s))
	}

	summary := ""
	if len(summaryParts) > 0 {
		summary = strings.Join(summaryParts, ", ")
	} else if s, ok := obj["summary"].(string); ok {
		summary = s
	}

	result := map[string]any{
		"key_data": keyData,
	}
	if summary != "" {
		result["summary"] = summary
	}
	return result
}
