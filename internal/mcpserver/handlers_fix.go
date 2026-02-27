package mcpserver

import (
	"context"
	"encoding/json"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/hookhandler"
)

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
			return mcp.NewToolResultText(noFixerResult(filePath)), nil
		}

		fix := fixer.Fix(finding, content)
		if fix == nil {
			return mcp.NewToolResultText(noFixResult(filePath, rule, message)), nil
		}

		result := map[string]any{
			"success":     true,
			"file_path":   filePath,
			"line":        line,
			"rule":        rule,
			"confidence":  fix.Confidence,
			"before":      fix.Before,
			"after":       fix.After,
			"explanation": fix.Explanation,
		}

		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func noFixerResult(filePath string) string {
	result := map[string]any{
		"success": false,
		"reason":  "no fixer available for this file type",
		"file":    filePath,
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	return string(data)
}

func noFixResult(filePath, rule, message string) string {
	result := map[string]any{
		"success": false,
		"reason":  "no fix available for this finding",
		"file":    filePath,
		"rule":    rule,
		"message": message,
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	return string(data)
}
