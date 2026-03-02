package mcpserver

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/store"
)

func recallHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		query := req.GetString("query", "")
		if query == "" {
			return mcp.NewToolResultError("query parameter is required"), nil
		}

		scope := req.GetString("scope", "")
		if scope == "" {
			scope = detectScope(query)
		}

		project := req.GetString("project", "")
		limit := req.GetInt("limit", 5)
		if limit < 1 {
			limit = 5
		}

		result := map[string]any{
			"query": query,
			"scope": scope,
		}

		switch scope {
		case "file":
			recallFile(st, query, project, limit, result)
		case "directory":
			recallDirectory(st, query, project, limit, result)
		case "project":
			recallProject(st, project, limit, result)
		default:
			recallAll(st, query, limit, result)
		}

		return marshalResult(result)
	}
}

// detectScope infers the search scope from the query string.
func detectScope(query string) string {
	if filepath.Ext(query) != "" {
		return "file"
	}
	if strings.Contains(query, "/") {
		return "directory"
	}
	return "all"
}

func recallFile(st *store.Store, query, project string, limit int, result map[string]any) {
	decisions, err := st.SearchDecisionsByFile(query, limit)
	if err == nil {
		result["decisions"] = formatDecisions(decisions)
	}

	coChanged, err := st.GetCoChangedFiles(query, 5)
	if err == nil && len(coChanged) > 0 {
		result["co_changed_files"] = formatFileActivities(coChanged)
	}

	if project != "" {
		hotspots, err := st.GetFileReworkHotspots(project, 2)
		if err == nil {
			suffix := store.PathSuffix(query)
			for _, h := range hotspots {
				if strings.HasSuffix(h.Path, suffix) {
					result["rework_sessions"] = h.SessionCount
					break
				}
			}
		}
	}
}

func recallDirectory(st *store.Store, query, project string, limit int, result map[string]any) {
	decisions, err := st.SearchDecisionsByDirectory(query, limit)
	if err == nil {
		result["decisions"] = formatDecisions(decisions)
	}

	if project != "" {
		hotspots, err := st.GetFileReworkHotspots(project, 2)
		if err == nil {
			dirPrefix := strings.TrimRight(query, "/") + "/"
			var filtered []map[string]any
			for _, h := range hotspots {
				if strings.HasPrefix(h.Path, dirPrefix) {
					filtered = append(filtered, map[string]any{
						"path":          h.Path,
						"session_count": h.SessionCount,
					})
				}
			}
			if len(filtered) > 0 {
				result["hotspot_files"] = filtered
			}
		}
	}
}

func recallProject(st *store.Store, project string, limit int, result map[string]any) {
	if project == "" {
		result["error"] = "project parameter is required for scope=project"
		return
	}

	stats, err := st.GetProjectSessionStats(project)
	if err == nil {
		result["session_stats"] = map[string]any{
			"total_sessions":       stats.TotalSessions,
			"total_turns":          stats.TotalTurns,
			"total_tool_uses":      stats.TotalToolUses,
			"total_compacts":       stats.TotalCompacts,
			"avg_turns_per_session": stats.AvgTurnsPerSession,
			"avg_compacts_per_session": stats.AvgCompactsPerSess,
		}
	}

	hotspots, err := st.GetFileReworkHotspots(project, 2)
	if err == nil && len(hotspots) > 0 {
		var items []map[string]any
		for _, h := range hotspots {
			items = append(items, map[string]any{
				"path":          h.Path,
				"session_count": h.SessionCount,
			})
		}
		result["hotspot_files"] = items
	}

	decisions, err := st.GetDecisions("", project, limit)
	if err == nil {
		result["recent_decisions"] = formatDecisions(decisions)
	}

	latest, err := st.GetLatestSession(project)
	if err == nil && latest != nil {
		result["latest_session"] = map[string]any{
			"id":            latest.ID,
			"first_event_at": latest.FirstEventAt,
			"last_event_at":  latest.LastEventAt,
			"first_prompt":   latest.FirstPrompt,
			"turn_count":     latest.TurnCount,
			"tool_use_count": latest.ToolUseCount,
		}
	}
}

func recallAll(st *store.Store, query string, limit int, result map[string]any) {
	decisions, err := st.SearchDecisionsFTS(query, "", limit)
	if err == nil {
		result["decisions"] = formatDecisions(decisions)
	}

	events, _, err := st.SearchEvents(query, "", -1, limit)
	if err == nil && len(events) > 0 {
		var items []map[string]any
		for _, e := range events {
			item := map[string]any{
				"session_id": e.SessionID,
				"timestamp":  e.Timestamp,
			}
			if e.UserText != "" {
				item["user_text"] = truncate(e.UserText, 200)
			}
			if e.AssistantText != "" {
				item["assistant_text"] = truncate(e.AssistantText, 200)
			}
			if e.ToolName != "" {
				item["tool_name"] = e.ToolName
			}
			items = append(items, item)
		}
		result["related_events"] = items
	}
}

// formatDecisions converts DecisionRow slices to JSON-friendly maps.
func formatDecisions(decisions []store.DecisionRow) []map[string]any {
	items := make([]map[string]any, 0, len(decisions))
	for _, d := range decisions {
		dm := map[string]any{
			"session_id": d.SessionID,
			"timestamp":  d.Timestamp,
			"topic":      d.Topic,
			"decision":   d.DecisionText,
		}
		if d.Reasoning != "" {
			dm["reasoning"] = d.Reasoning
		}
		if d.FilePaths != "" && d.FilePaths != "[]" {
			var paths []string
			if json.Unmarshal([]byte(d.FilePaths), &paths) == nil {
				dm["file_paths"] = paths
			}
		}
		items = append(items, dm)
	}
	return items
}

// formatFileActivities converts FileActivity slices to JSON-friendly maps.
func formatFileActivities(activities []store.FileActivity) []map[string]any {
	items := make([]map[string]any, 0, len(activities))
	for _, a := range activities {
		items = append(items, map[string]any{
			"path":          a.Path,
			"action":        a.Action,
			"session_count": a.Count,
		})
	}
	return items
}
