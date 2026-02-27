package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/store"
)

func feedbackHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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

		rating := store.FeedbackRating(ratingStr)
		switch rating {
		case store.RatingHelpful, store.RatingPartiallyHelpful,
			store.RatingNotHelpful, store.RatingMisleading:
			// valid
		default:
			return mcp.NewToolResultError(
				fmt.Sprintf("invalid rating %q: must be helpful, partially_helpful, not_helpful, or misleading", ratingStr),
			), nil
		}

		suggestionID := int64(req.GetInt("suggestion_id", 0))
		comment := req.GetString("comment", "")

		// Determine session ID from the most recent session.
		sessionID := latestSessionID(st)

		if err := st.InsertFeedback(sessionID, pattern, rating, comment, suggestionID); err != nil {
			return mcp.NewToolResultError("failed to record feedback: " + err.Error()), nil
		}

		// Update the effectiveness score using the feedback signal.
		resolved := rating == store.RatingHelpful || rating == store.RatingPartiallyHelpful
		responseTime := 0.0
		if resolved {
			responseTime = 3.0 // nominal value for explicit feedback
		}
		_ = st.UpsertUserPreference(pattern, resolved, responseTime)

		// Return current stats for transparency.
		stats, _ := st.PatternFeedbackStats(pattern)
		result := map[string]any{
			"success": true,
			"pattern": pattern,
			"rating":  ratingStr,
		}
		if stats != nil {
			result["feedback_stats"] = map[string]any{
				"total":          stats.TotalCount,
				"helpful":        stats.Helpful,
				"not_helpful":    stats.NotHelpful,
				"weighted_score": fmt.Sprintf("%.2f", stats.WeightedScore),
			}
		}

		return marshalResult(result)
	}
}

// latestSessionID returns the most recent session ID from the store.
// marshalResult converts a value to indented JSON and returns an MCP tool result.
// On encoding failure, returns an MCP error result instead of silently dropping the error.
func marshalResult(v any) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return mcp.NewToolResultError("failed to encode result: " + err.Error()), nil
	}
	return mcp.NewToolResultText(string(data)), nil
}

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
