package mcpserver

import (
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
)

// truncate shortens a string to maxLen runes, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}

// objectItems returns a PropertyOption that sets array items to an object
// with the given required string properties.
func objectItems(props ...string) mcp.PropertyOption {
	return func(schema map[string]any) {
		properties := make(map[string]any, len(props))
		for _, p := range props {
			properties[p] = map[string]any{"type": "string"}
		}
		schema["items"] = map[string]any{
			"type":       "object",
			"properties": properties,
			"required":   props,
		}
	}
}

// marshalResult encodes v as JSON and wraps it in an MCP CallToolResult.
func marshalResult(v any) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return mcp.NewToolResultError("failed to marshal result"), nil
	}
	return mcp.NewToolResultText(string(data)), nil
}
