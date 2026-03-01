package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// FeedbackRating represents the user's assessment of a suggestion.
type FeedbackRating string

const (
	RatingHelpful           FeedbackRating = "helpful"
	RatingPartiallyHelpful  FeedbackRating = "partially_helpful"
	RatingNotHelpful        FeedbackRating = "not_helpful"
	RatingMisleading        FeedbackRating = "misleading"
)

func feedbackHandler(st *store.Store) server.ToolHandlerFunc {
	return func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		pattern := req.GetString("pattern", "")
		if pattern == "" {
			return mcp.NewToolResultError("pattern parameter is required"), nil
		}
		ratingStr := req.GetString("rating", "")
		if ratingStr == "" {
			return mcp.NewToolResultError("rating parameter is required"), nil
		}

		rating := FeedbackRating(ratingStr)
		switch rating {
		case RatingHelpful, RatingPartiallyHelpful,
			RatingNotHelpful, RatingMisleading:
			// valid
		default:
			return mcp.NewToolResultError(
				fmt.Sprintf("invalid rating %q: must be helpful, partially_helpful, not_helpful, or misleading", ratingStr),
			), nil
		}

		comment := req.GetString("comment", "")

		// Record feedback via UserPreference (the only remaining feedback mechanism).
		resolved := rating == RatingHelpful || rating == RatingPartiallyHelpful
		responseTime := 0.0
		if resolved {
			responseTime = 3.0
		}
		_ = st.UpsertUserPreference(pattern, resolved, responseTime)

		result := map[string]any{
			"success": true,
			"pattern": pattern,
			"rating":  ratingStr,
			"comment": comment,
		}

		return marshalResult(result)
	}
}

// marshalResult converts a value to indented JSON and returns an MCP tool result.
// On encoding failure, returns an MCP error result instead of silently dropping the error.
func marshalResult(v any) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return mcp.NewToolResultError("failed to encode result: " + err.Error()), nil
	}
	return mcp.NewToolResultText(string(data)), nil
}

// latestSessionID returns the most recent session ID from the store.
func latestSessionID(st *store.Store) string {
	var id string
	err := st.DB().QueryRow(
		`SELECT id FROM sessions ORDER BY last_event_at DESC LIMIT 1`,
	).Scan(&id)
	if err != nil {
		return "unknown"
	}
	return id
}
