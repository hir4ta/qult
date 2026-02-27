package mcpserver

import (
	"context"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

func statsHandler(claudeHome string) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		sessions, err := watcher.ListSessions(claudeHome)
		if err != nil {
			return mcp.NewToolResultError("failed to list sessions: " + err.Error()), nil
		}
		if len(sessions) == 0 {
			return mcp.NewToolResultError("no sessions found"), nil
		}

		sessionID := req.GetString("session_id", "")
		limit := req.GetInt("limit", 1)
		if limit < 1 {
			limit = 1
		}
		if limit > len(sessions) {
			limit = len(sessions)
		}

		var targets []watcher.SessionInfo
		if sessionID != "" {
			for _, s := range sessions {
				if strings.HasPrefix(s.SessionID, sessionID) {
					targets = append(targets, s)
					break
				}
			}
			if len(targets) == 0 {
				return mcp.NewToolResultError("session not found: " + sessionID), nil
			}
		} else {
			targets = sessions[:limit]
		}

		var results []map[string]any
		for _, si := range targets {
			detail, err := watcher.LoadSessionDetail(si)
			if err != nil {
				continue
			}
			liveStats := analyzer.NewStats()
			for _, ev := range detail.Events {
				liveStats.Update(ev)
			}
			results = append(results, map[string]any{
				"session_id":      si.SessionID[:8],
				"project":         si.Project,
				"turns":           detail.Stats.TurnCount,
				"tool_uses":       detail.Stats.ToolUseCount,
				"tools_per_turn":  liveStats.ToolsPerTurn(),
				"tool_freq":       detail.Stats.ToolFreq,
				"longest_pause_s": int(liveStats.LongestPause.Seconds()),
				"duration_min":    sessionDurationMin(detail.Stats),
				"last_activity":   si.ModTime.Format("2006-01-02 15:04"),
			})
		}

		return marshalResult(results)
	}
}

func sessionsHandler(claudeHome string) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		limit := req.GetInt("limit", 10)
		if limit < 1 {
			limit = 1
		}

		sessions, err := watcher.ListSessions(claudeHome)
		if err != nil {
			return mcp.NewToolResultError("failed to list sessions: " + err.Error()), nil
		}

		if limit > len(sessions) {
			limit = len(sessions)
		}

		var results []map[string]any
		for _, s := range sessions[:limit] {
			results = append(results, map[string]any{
				"session_id":    s.SessionID[:8],
				"project":       s.Project,
				"size_kb":       s.Size / 1024,
				"last_activity": s.ModTime.Format("2006-01-02 15:04"),
			})
		}

		return marshalResult(results)
	}
}

func sessionDurationMin(stats watcher.SessionStats) int {
	if stats.FirstTime.IsZero() || stats.LastTime.IsZero() {
		return 0
	}
	return int(stats.LastTime.Sub(stats.FirstTime).Minutes())
}
