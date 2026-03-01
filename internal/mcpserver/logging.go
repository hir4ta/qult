package mcpserver

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// SendAlert sends an MCP log notification to the client.
// Level should be one of: "debug", "info", "warning", "error", "critical".
func SendAlert(ctx context.Context, s *server.MCPServer, level, logger, message string) {
	mcpLevel := mcp.LoggingLevel(level)
	s.SendNotificationToAllClients("notifications/message", map[string]any{
		"method": "notifications/message",
		"params": map[string]any{
			"level":  mcpLevel,
			"logger": logger,
			"data":   message,
		},
	})
}

// SendAlertIfWarning sends a log notification only for warning-level or above alerts.
func SendAlertIfWarning(ctx context.Context, s *server.MCPServer, level, message string) {
	switch level {
	case "warning", "error", "critical":
		SendAlert(ctx, s, level, "claude-alfred", message)
	}
}
