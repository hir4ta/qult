package mcpserver

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

func alertsHandler(claudeHome string, lang locale.Lang) server.ToolHandlerFunc {
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

		det := analyzer.NewDetector(lang.Code)
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

		// Enrich with EWMA flow metrics and anomaly status from sessiondb.
		if sdb, err := sessiondb.Open(target.SessionID); err == nil {
			defer sdb.Close()
			enrichAlertsFromSessionDB(sdb, result)
		}

		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

// enrichAlertsFromSessionDB adds EWMA flow metrics and anomaly status to alerts output.
func enrichAlertsFromSessionDB(sdb *sessiondb.SessionDB, result map[string]any) {
	flowMetrics := map[string]any{}

	if vel, _ := sdb.GetContext("ewma_tool_velocity"); vel != "" {
		flowMetrics["tool_velocity"] = vel
	}
	if errRate, _ := sdb.GetContext("ewma_error_rate"); errRate != "" {
		flowMetrics["error_rate"] = errRate
	}
	if accRate, _ := sdb.GetContext("ewma_acceptance_rate"); accRate != "" {
		flowMetrics["acceptance_rate"] = accRate
	}

	if len(flowMetrics) > 0 {
		result["flow_metrics"] = flowMetrics
	}

	// Check for anomalies from recent phases.
	phases, err := sdb.GetRawPhaseSequence(20)
	if err == nil && len(phases) >= 10 {
		recent := phases
		if len(recent) > 10 {
			recent = recent[len(recent)-10:]
		}
		counts := make(map[string]int)
		for _, p := range recent {
			counts[p]++
		}
		result["recent_phase_distribution"] = counts
	}
}
