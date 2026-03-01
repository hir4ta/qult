package mcpserver

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// accuracyHandler is a placeholder — accuracy metrics were removed in alfred v1.
func accuracyHandler(_ *store.Store) server.ToolHandlerFunc {
	return func(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return marshalResult(map[string]any{
			"status":  "not_available",
			"message": "Accuracy metrics will be replaced by docs-based knowledge tracking in alfred v1.",
		})
	}
}
