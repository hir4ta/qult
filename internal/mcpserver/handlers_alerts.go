package mcpserver

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

// AlertEntry is a typed alert item in the alerts response.
type AlertEntry struct {
	PatternName string `json:"pattern_name"`
	Level       string `json:"level"`
	Situation   string `json:"situation"`
	Observation string `json:"observation"`
	Suggestion  string `json:"suggestion"`
	EventCount  int    `json:"event_count"`
	Timestamp   string `json:"timestamp"`
}

// FlowMetrics holds EWMA flow metrics from sessiondb.
type FlowMetrics struct {
	ToolVelocity   float64 `json:"tool_velocity,omitempty"`
	ErrorRate      float64 `json:"error_rate,omitempty"`
	AcceptanceRate float64 `json:"acceptance_rate,omitempty"`
}

// PhaseCount represents a phase name with its occurrence count, for ordered output.
type PhaseCount struct {
	Phase string `json:"phase"`
	Count int    `json:"count"`
}

// AlertsResponse is the typed response for the buddy_alerts MCP tool.
type AlertsResponse struct {
	ActiveAlerts      []AlertEntry `json:"active_alerts"`
	SessionHealth     float64      `json:"session_health"`
	TotalDetected     int          `json:"total_detected"`
	FlowMetrics       *FlowMetrics `json:"flow_metrics,omitempty"`
	RecentPhaseCounts []PhaseCount `json:"recent_phase_counts,omitempty"`
}

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
		alertList := make([]AlertEntry, 0, len(activeAlerts))
		for _, a := range activeAlerts {
			alertList = append(alertList, AlertEntry{
				PatternName: analyzer.PatternName(a.Pattern),
				Level:       levelString(a.Level),
				Situation:   a.Situation,
				Observation: a.Observation,
				Suggestion:  a.Suggestion,
				EventCount:  a.EventCount,
				Timestamp:   a.Timestamp.Format("2006-01-02 15:04:05"),
			})
		}

		resp := AlertsResponse{
			ActiveAlerts:  alertList,
			SessionHealth: det.SessionHealth(),
			TotalDetected: totalDetected,
		}

		// Enrich with EWMA flow metrics and anomaly status from sessiondb.
		if sdb, err := sessiondb.Open(target.SessionID); err == nil {
			defer sdb.Close()
			enrichAlertsFromSessionDB(sdb, &resp)
		}

		return marshalResult(resp)
	}
}

// enrichAlertsFromSessionDB adds EWMA flow metrics and anomaly status to alerts output.
func enrichAlertsFromSessionDB(sdb *sessiondb.SessionDB, resp *AlertsResponse) {
	var fm FlowMetrics
	hasMetrics := false

	if vel, _ := sdb.GetContext("ewma_tool_velocity"); vel != "" {
		if v, err := strconv.ParseFloat(vel, 64); err == nil {
			fm.ToolVelocity = v
			hasMetrics = true
		}
	}
	if errRate, _ := sdb.GetContext("ewma_error_rate"); errRate != "" {
		if v, err := strconv.ParseFloat(errRate, 64); err == nil {
			fm.ErrorRate = v
			hasMetrics = true
		}
	}
	if accRate, _ := sdb.GetContext("ewma_acceptance_rate"); accRate != "" {
		if v, err := strconv.ParseFloat(accRate, 64); err == nil {
			fm.AcceptanceRate = v
			hasMetrics = true
		}
	}

	if hasMetrics {
		resp.FlowMetrics = &fm
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
		// Convert to sorted slice for deterministic JSON output.
		phaseCounts := make([]PhaseCount, 0, len(counts))
		for phase, count := range counts {
			phaseCounts = append(phaseCounts, PhaseCount{Phase: phase, Count: count})
		}
		sort.Slice(phaseCounts, func(i, j int) bool {
			if phaseCounts[i].Count != phaseCounts[j].Count {
				return phaseCounts[i].Count > phaseCounts[j].Count
			}
			return phaseCounts[i].Phase < phaseCounts[j].Phase
		})
		resp.RecentPhaseCounts = phaseCounts
	}
}
