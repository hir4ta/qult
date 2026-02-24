package mcpserver

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

func alertsHandler(claudeHome string) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		sessions, err := watcher.ListSessions(claudeHome)
		if err != nil || len(sessions) == 0 {
			return mcp.NewToolResultError("no sessions found"), nil
		}

		sessionID := req.GetString("session_id", "")
		var target watcher.SessionInfo
		if sessionID != "" {
			for _, s := range sessions {
				if strings.HasPrefix(s.SessionID, sessionID) {
					target = s
					break
				}
			}
			if target.Path == "" {
				return mcp.NewToolResultError("session not found: " + sessionID), nil
			}
		} else {
			target = sessions[0]
		}

		detail, err := watcher.LoadSessionDetail(target)
		if err != nil {
			return mcp.NewToolResultError("failed to load session: " + err.Error()), nil
		}

		det := analyzer.NewDetector()
		totalDetected := 0
		for _, ev := range detail.Events {
			alerts := det.Update(ev)
			totalDetected += len(alerts)
		}

		activeAlerts := det.ActiveAlerts()
		alertList := make([]map[string]any, 0, len(activeAlerts))
		for _, a := range activeAlerts {
			alertList = append(alertList, map[string]any{
				"pattern_name": analyzer.PatternName(a.Pattern),
				"level":        levelString(a.Level),
				"situation":    a.Situation,
				"observation":  a.Observation,
				"suggestion":   a.Suggestion,
				"event_count":  a.EventCount,
				"timestamp":    a.Timestamp.Format("2006-01-02 15:04:05"),
			})
		}

		result := map[string]any{
			"active_alerts":  alertList,
			"session_health": det.SessionHealth(),
			"total_detected": totalDetected,
		}

		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}
