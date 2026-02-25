package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// registerResources adds MCP resources to the server.
func registerResources(s *server.MCPServer, claudeHome string, lang locale.Lang, st *store.Store) {
	s.AddResources(
		server.ServerResource{
			Resource: mcp.Resource{
				URI:         "buddy://health",
				Name:        "Session Health",
				Description: "Current session health score and alert count",
				MIMEType:    "application/json",
			},
			Handler: healthResource(claudeHome, lang),
		},
		server.ServerResource{
			Resource: mcp.Resource{
				URI:         "buddy://alerts",
				Name:        "Active Alerts",
				Description: "Active anti-pattern alerts with observations and suggestions",
				MIMEType:    "application/json",
			},
			Handler: alertsResource(claudeHome, lang),
		},
		server.ServerResource{
			Resource: mcp.Resource{
				URI:         "buddy://decisions",
				Name:        "Design Decisions",
				Description: "Past design decisions from stored sessions",
				MIMEType:    "application/json",
			},
			Handler: decisionsResource(st),
		},
	)
}

func healthResource(claudeHome string, lang locale.Lang) server.ResourceHandlerFunc {
	return func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		session := findLatestSession(claudeHome)
		if session == nil {
			return jsonResource("buddy://health", map[string]any{
				"health_score": 1.0,
				"alert_count":  0,
				"status":       "no active session",
			})
		}

		alerts, score := computeAlertsAndScore(session, lang)
		return jsonResource("buddy://health", map[string]any{
			"health_score": score,
			"alert_count":  len(alerts),
			"session_id":   session.SessionID,
		})
	}
}

func alertsResource(claudeHome string, lang locale.Lang) server.ResourceHandlerFunc {
	return func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		session := findLatestSession(claudeHome)
		if session == nil {
			return jsonResource("buddy://alerts", []any{})
		}

		alerts, _ := computeAlertsAndScore(session, lang)
		var result []map[string]string
		for _, a := range alerts {
			result = append(result, map[string]string{
				"pattern":     a.Pattern,
				"level":       a.Level,
				"observation": a.Observation,
				"suggestion":  a.Suggestion,
			})
		}
		return jsonResource("buddy://alerts", result)
	}
}

func decisionsResource(st *store.Store) server.ResourceHandlerFunc {
	return func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		if st == nil {
			return jsonResource("buddy://decisions", []any{})
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
		return jsonResource("buddy://decisions", result)
	}
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
