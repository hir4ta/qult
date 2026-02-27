package mcpserver

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/store"
)

type crossProjectResult struct {
	Patterns []crossProjectEntry `json:"patterns"`
	Total    int                 `json:"total"`
}

type crossProjectEntry struct {
	SourceProject string   `json:"source_project"`
	Type          string   `json:"type"`
	Title         string   `json:"title"`
	Content       string   `json:"content"`
	Keywords      []string `json:"keywords,omitempty"`
	Effectiveness float64  `json:"effectiveness"`
}

func crossProjectHandler() server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		query := req.GetString("query", "")
		if query == "" {
			return mcp.NewToolResultError("query is required"), nil
		}
		patternType := req.GetString("pattern_type", "")
		limit := req.GetInt("limit", 5)

		gs, err := store.OpenGlobal()
		if err != nil {
			return mcp.NewToolResultError("global store unavailable: " + err.Error()), nil
		}
		defer gs.Close()

		patterns, err := gs.SearchPatterns(query, patternType, limit)
		if err != nil {
			return mcp.NewToolResultError("search failed: " + err.Error()), nil
		}

		result := crossProjectResult{Total: len(patterns)}
		for _, p := range patterns {
			result.Patterns = append(result.Patterns, crossProjectEntry{
				SourceProject: p.SourceProject,
				Type:          p.PatternType,
				Title:         p.Title,
				Content:       p.Content,
				Keywords:      p.Keywords,
				Effectiveness: p.Effectiveness,
			})
		}

		if len(result.Patterns) == 0 {
			return mcp.NewToolResultText(fmt.Sprintf("No cross-project patterns found for %q", query)), nil
		}

		return marshalResult(result)
	}
}
