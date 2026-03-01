package mcpserver

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/store"
)

func preferencesHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		action := req.GetString("action", "get")

		switch action {
		case "get":
			return preferencesGet(st, req)
		case "set":
			return preferencesSet(st, req)
		case "delete":
			return preferencesDelete(st, req)
		default:
			return mcp.NewToolResultError(fmt.Sprintf("unknown action: %s (use get, set, or delete)", action)), nil
		}
	}
}

func preferencesGet(st *store.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	category := req.GetString("category", "")

	prefs, err := st.GetPreferences(category)
	if err != nil {
		return mcp.NewToolResultError("failed to get preferences: " + err.Error()), nil
	}

	items := make([]map[string]any, 0, len(prefs))
	for _, p := range prefs {
		items = append(items, map[string]any{
			"category":   p.Category,
			"key":        p.Key,
			"value":      p.Value,
			"source":     p.Source,
			"confidence": p.Confidence,
		})
	}

	return marshalResult(map[string]any{
		"action":      "get",
		"preferences": items,
		"total":       len(items),
	})
}

func preferencesSet(st *store.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	category := req.GetString("category", "")
	key := req.GetString("key", "")
	value := req.GetString("value", "")
	source := req.GetString("source", "explicit")
	confidence := 1.0
	if source == "inferred" {
		confidence = 0.7
	}

	if category == "" || key == "" || value == "" {
		return mcp.NewToolResultError("category, key, and value are required"), nil
	}

	err := st.SetPreference(category, key, value, source, confidence)
	if err != nil {
		return mcp.NewToolResultError("failed to set preference: " + err.Error()), nil
	}

	return marshalResult(map[string]any{
		"action":     "set",
		"category":   category,
		"key":        key,
		"value":      value,
		"source":     source,
		"confidence": confidence,
	})
}

func preferencesDelete(st *store.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	category := req.GetString("category", "")
	key := req.GetString("key", "")

	if category == "" || key == "" {
		return mcp.NewToolResultError("category and key are required for delete"), nil
	}

	err := st.DeletePreference(category, key)
	if err != nil {
		return mcp.NewToolResultError("failed to delete preference: " + err.Error()), nil
	}

	return marshalResult(map[string]any{
		"action":   "delete",
		"category": category,
		"key":      key,
	})
}

