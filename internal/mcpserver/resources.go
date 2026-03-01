package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/hookhandler"
	"github.com/hir4ta/claude-alfred/internal/sessiondb"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// registerResources adds MCP resources to the server.
func registerResources(s *server.MCPServer, claudeHome string, st *store.Store) {
	s.AddResources(
		server.ServerResource{
			Resource: mcp.Resource{
				URI:         "alfred://health",
				Name:        "Session Health",
				Description: "Current session health score and alert count",
				MIMEType:    "application/json",
			},
			Handler: healthResource(claudeHome),
		},
		server.ServerResource{
			Resource: mcp.Resource{
				URI:         "alfred://alerts",
				Name:        "Active Alerts",
				Description: "Active anti-pattern alerts with observations and suggestions",
				MIMEType:    "application/json",
			},
			Handler: alertsResource(claudeHome),
		},
		server.ServerResource{
			Resource: mcp.Resource{
				URI:         "alfred://decisions",
				Name:        "Design Decisions",
				Description: "Past design decisions from stored sessions",
				MIMEType:    "application/json",
			},
			Handler: decisionsResource(st),
		},
		server.ServerResource{
			Resource: mcp.Resource{
				URI:         "alfred://health-timeline",
				Name:        "Health Timeline",
				Description: "Session health snapshots with trend prediction and sparkline",
				MIMEType:    "application/json",
			},
			Handler: healthTimelineResource(claudeHome),
		},
	)
}

func healthResource(claudeHome string) server.ResourceHandlerFunc {
	return func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		session := findLatestSession(claudeHome)
		if session == nil {
			return jsonResource("alfred://health", map[string]any{
				"health_score": 1.0,
				"alert_count":  0,
				"status":       "no active session",
			})
		}

		alerts, score := computeAlertsAndScore(session)
		return jsonResource("alfred://health", map[string]any{
			"health_score": score,
			"alert_count":  len(alerts),
			"session_id":   session.SessionID,
		})
	}
}

func alertsResource(claudeHome string) server.ResourceHandlerFunc {
	return func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		session := findLatestSession(claudeHome)
		if session == nil {
			return jsonResource("alfred://alerts", []any{})
		}

		alerts, _ := computeAlertsAndScore(session)
		var result []map[string]string
		for _, a := range alerts {
			result = append(result, map[string]string{
				"pattern":     a.Pattern,
				"level":       a.Level,
				"observation": a.Observation,
				"suggestion":  a.Suggestion,
			})
		}
		return jsonResource("alfred://alerts", result)
	}
}

func decisionsResource(st *store.Store) server.ResourceHandlerFunc {
	return func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		if st == nil {
			return jsonResource("alfred://decisions", []any{})
		}

		decisions, err := st.SearchDecisions("", "", 20)
		if err != nil {
			return nil, fmt.Errorf("search decisions: %w", err)
		}

		var result []map[string]string
		for _, d := range decisions {
			result = append(result, map[string]string{
				"topic":    d.Topic,
				"decision": d.DecisionText,
			})
		}
		return jsonResource("alfred://decisions", result)
	}
}

func healthTimelineResource(claudeHome string) server.ResourceHandlerFunc {
	return func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		session := findLatestSession(claudeHome)
		if session == nil {
			return jsonResource("alfred://health-timeline", map[string]any{
				"snapshots": []any{},
				"trend":     nil,
				"sparkline": "",
			})
		}

		sdb, err := sessiondb.Open(session.SessionID)
		if err != nil {
			return jsonResource("alfred://health-timeline", map[string]any{
				"error": "failed to open session db",
			})
		}
		defer sdb.Close()

		snapshots, _ := sdb.RecentHealthSnapshots(20)
		var snapshotData []map[string]any
		for _, s := range snapshots {
			snapshotData = append(snapshotData, map[string]any{
				"tool_count": s.ToolCount,
				"health":     s.Health,
				"velocity":   s.Velocity,
				"error_rate": s.ErrorRate,
			})
		}

		// Build sparkline from health values.
		sparkline := buildSparkline(snapshots)

		// Get trend prediction.
		var trendData map[string]any
		if trend := hookhandler.PredictHealthTrend(sdb); trend != nil {
			trendData = map[string]any{
				"current_health":     trend.CurrentHealth,
				"slope_per_10":       trend.Slope,
				"trend":              trend.Trend,
				"tools_to_threshold": trend.ToolsToThreshold,
				"compound_risk":      trend.CompoundRisk,
			}
			if trend.RecoveryPlaybook != "" {
				trendData["recovery_playbook"] = trend.RecoveryPlaybook
			}
		}

		return jsonResource("alfred://health-timeline", map[string]any{
			"snapshots": snapshotData,
			"trend":     trendData,
			"sparkline": sparkline,
		})
	}
}

// buildSparkline creates a Unicode sparkline from health snapshots.
func buildSparkline(snapshots []sessiondb.HealthSnapshot) string {
	if len(snapshots) == 0 {
		return ""
	}
	blocks := []rune("▁▂▃▄▅▆▇█")
	var result []rune
	for _, s := range snapshots {
		idx := int(s.Health * float64(len(blocks)-1))
		if idx < 0 {
			idx = 0
		}
		if idx >= len(blocks) {
			idx = len(blocks) - 1
		}
		result = append(result, blocks[idx])
	}
	return string(result)
}

func jsonResource(uri string, data any) ([]mcp.ResourceContents, error) {
	b, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshal resource: %w", err)
	}
	return []mcp.ResourceContents{
		mcp.TextResourceContents{
			URI:      uri,
			MIMEType: "application/json",
			Text:     string(b),
		},
	}, nil
}
