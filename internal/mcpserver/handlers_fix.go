package mcpserver

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// FixResponse is the typed response for the buddy_fix MCP tool.
// Code quality fixers have been removed; this returns a stub response.
type FixResponse struct {
	Success  bool   `json:"success"`
	FilePath string `json:"file_path,omitempty"`
	Rule     string `json:"rule,omitempty"`
	Message  string `json:"message,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

func fixHandler() server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		filePath := req.GetString("file_path", "")
		rule := req.GetString("finding_rule", "")
		message := req.GetString("message", "")

		return marshalResult(FixResponse{
			Reason:   "code quality fixers removed — use buddy_diagnose for error diagnosis",
			FilePath: filePath,
			Rule:     rule,
			Message:  message,
		})
	}
}
