package hookhandler

import (
	"encoding/json"
	"fmt"
	"strings"
)

type permissionRequestInput struct {
	CommonInput
	ToolName   string `json:"tool_name"`
	ServerName string `json:"server_name,omitempty"`
}

// handlePermissionRequest auto-allows alfred MCP tools to avoid user interruption.
// Matches tools prefixed with "alfred_" or server named "claude-alfred".
func handlePermissionRequest(input []byte) (*HookOutput, error) {
	var in permissionRequestInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// Auto-allow alfred MCP tools.
	if strings.HasPrefix(in.ToolName, "alfred_") ||
		strings.HasPrefix(in.ToolName, "mcp__claude-alfred__") ||
		in.ServerName == "claude-alfred" {
		return makeAllowOutput("[alfred] Auto-allowing alfred MCP tool"), nil
	}

	// Safe read-only tools: auto-allow without user interruption.
	switch in.ToolName {
	case "Read", "Glob", "Grep", "WebSearch", "WebFetch":
		return makeAllowOutput("[alfred] Auto-allowing read-only tool"), nil
	}

	return nil, nil
}
