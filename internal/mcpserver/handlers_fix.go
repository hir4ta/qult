package mcpserver

import (
	"context"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/hookhandler"
)

// FixResponse is the typed response for the buddy_fix MCP tool.
type FixResponse struct {
	Success              bool    `json:"success"`
	FilePath             string  `json:"file_path,omitempty"`
	Line                 int     `json:"line,omitempty"`
	Rule                 string  `json:"rule,omitempty"`
	Message              string  `json:"message,omitempty"`
	Confidence           float64 `json:"confidence,omitempty"`
	ConfidenceAdjustment float64 `json:"confidence_adjustment,omitempty"`
	Before               string  `json:"before,omitempty"`
	After                string  `json:"after,omitempty"`
	Explanation          string  `json:"explanation,omitempty"`
	Reason               string  `json:"reason,omitempty"`
}

func fixHandler() server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		filePath := req.GetString("file_path", "")
		if filePath == "" {
			return mcp.NewToolResultError("file_path parameter is required"), nil
		}
		rule := req.GetString("finding_rule", "")
		message := req.GetString("message", "")
		if rule == "" && message == "" {
			return mcp.NewToolResultError("finding_rule or message parameter is required"), nil
		}
		line := req.GetInt("line", 0)

		content, err := os.ReadFile(filePath)
		if err != nil {
			return mcp.NewToolResultError("cannot read file: " + err.Error()), nil
		}

		finding := hookhandler.Finding{
			File:    filePath,
			Rule:    rule,
			Message: message,
			Line:    line,
		}

		fixer := hookhandler.GetFixer(filePath)
		if fixer == nil {
			return marshalResult(FixResponse{
				Reason:   "no fixer available for this file type",
				FilePath: filePath,
			})
		}

		fix := fixer.Fix(finding, content)
		if fix == nil {
			return marshalResult(FixResponse{
				Reason:   "no fix available for this finding",
				FilePath: filePath,
				Rule:     rule,
				Message:  message,
			})
		}

		return marshalResult(FixResponse{
			Success:              true,
			FilePath:             filePath,
			Line:                 line,
			Rule:                 rule,
			Confidence:           fix.Confidence,
			ConfidenceAdjustment: fix.ConfidenceAdjustment,
			Before:               fix.Before,
			After:                fix.After,
			Explanation:          fix.Explanation,
		})
	}
}
