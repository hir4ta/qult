package mcpserver

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/coach"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/store"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

// New creates a new MCP server with all tools registered.
func New(claudeHome string, lang locale.Lang, st *store.Store) *server.MCPServer {
	s := server.NewMCPServer(
		"claude-buddy",
		"0.2.0",
		server.WithToolCapabilities(true),
	)

	s.AddTools(
		server.ServerTool{
			Tool: mcp.NewTool("buddy_stats",
				mcp.WithDescription("Get usage statistics for Claude Code sessions. Returns turn counts, tool usage frequency, and session duration."),
				mcp.WithString("session_id",
					mcp.Description("Session ID to analyze (optional, defaults to most recent)"),
				),
				mcp.WithNumber("limit",
					mcp.Description("Number of recent sessions to include (default: 1)"),
				),
			),
			Handler: statsHandler(claudeHome),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_tips",
				mcp.WithDescription("Get AI-powered usage improvement tips for a session via claude -p."),
				mcp.WithString("session_id",
					mcp.Description("Session ID to analyze (optional, defaults to most recent)"),
				),
			),
			Handler: tipsHandler(claudeHome, lang),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_sessions",
				mcp.WithDescription("List recent Claude Code sessions with basic metadata."),
				mcp.WithNumber("limit",
					mcp.Description("Maximum number of sessions to return (default: 10)"),
				),
			),
			Handler: sessionsHandler(claudeHome),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_resume",
				mcp.WithDescription("Resume context from a previous Claude Code session. Call this at session start to recover prior context. Returns summary, recent events, decisions, and files modified."),
				mcp.WithString("session_id",
					mcp.Description("Session ID to resume from (optional, defaults to most recent)"),
				),
				mcp.WithString("project",
					mcp.Description("Project name or path to filter sessions (optional)"),
				),
			),
			Handler: resumeHandler(st),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_recall",
				mcp.WithDescription("Recall details lost during auto-compact. Searches pre-compact conversation history for specific topics, file paths, or decisions. Call this when you notice context has been compacted and need specific details."),
				mcp.WithString("query",
					mcp.Description("Search query for finding specific details"),
					mcp.Required(),
				),
				mcp.WithString("session_id",
					mcp.Description("Session ID to search in (optional, defaults to most recent)"),
				),
				mcp.WithNumber("segment",
					mcp.Description("Compact segment to search (0=pre-compact, default: 0)"),
				),
				mcp.WithNumber("limit",
					mcp.Description("Maximum number of results to return (default: 10)"),
				),
			),
			Handler: recallHandler(st),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_decisions",
				mcp.WithDescription("List design decisions from past sessions. Decisions are extracted from assistant messages containing architectural choices. Use before making related changes."),
				mcp.WithString("session_id",
					mcp.Description("Session ID to filter decisions (optional)"),
				),
				mcp.WithString("project",
					mcp.Description("Project name to filter decisions (optional)"),
				),
				mcp.WithString("query",
					mcp.Description("FTS5 search query to find specific decisions (optional)"),
				),
				mcp.WithNumber("limit",
					mcp.Description("Maximum number of decisions to return (default: 20)"),
				),
			),
			Handler: decisionsHandler(st),
		},
	)

	return s
}

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
			// Compute live stats for tools_per_turn and longest_pause
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

		data, _ := json.MarshalIndent(results, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func tipsHandler(claudeHome string, lang locale.Lang) server.ToolHandlerFunc {
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

		stats := analyzer.NewStats()
		for _, ev := range detail.Events {
			stats.Update(ev)
		}

		fb, err := coach.GenerateFeedback(ctx, detail.Events, stats, lang, nil)
		if err != nil {
			return mcp.NewToolResultError("AI feedback generation failed: " + err.Error()), nil
		}

		result := map[string]any{
			"situation":   fb.Situation,
			"observation": fb.Observation,
			"suggestion":  fb.Suggestion,
			"level":       levelString(fb.Level),
		}
		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func sessionDurationMin(stats watcher.SessionStats) int {
	if stats.FirstTime.IsZero() || stats.LastTime.IsZero() {
		return 0
	}
	return int(stats.LastTime.Sub(stats.FirstTime).Minutes())
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

		data, _ := json.MarshalIndent(results, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func resumeHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		sessionID := req.GetString("session_id", "")
		project := req.GetString("project", "")

		var sess *store.SessionRow
		var err error
		if sessionID != "" {
			sess, err = st.GetSession(sessionID)
		} else {
			sess, err = st.GetLatestSession(project)
		}
		if err != nil {
			return mcp.NewToolResultError("session not found: " + err.Error()), nil
		}

		recentEvents, err := st.GetRecentEvents(sess.ID, 20)
		if err != nil {
			return mcp.NewToolResultError("failed to get events: " + err.Error()), nil
		}

		decisions, err := st.GetDecisions(sess.ID, "", 15)
		if err != nil {
			return mcp.NewToolResultError("failed to get decisions: " + err.Error()), nil
		}

		filesModified, err := st.GetFilesModified(sess.ID, 30)
		if err != nil {
			return mcp.NewToolResultError("failed to get files: " + err.Error()), nil
		}

		chain, err := st.GetSessionChain(sess.ID)
		if err != nil {
			return mcp.NewToolResultError("failed to get session chain: " + err.Error()), nil
		}

		// Find last user and assistant messages from recent events.
		var lastUser, lastAssistant string
		for _, ev := range recentEvents {
			if lastUser == "" && ev.UserText != "" {
				lastUser = ev.UserText
			}
			if lastAssistant == "" && ev.AssistantText != "" {
				lastAssistant = ev.AssistantText
			}
			if lastUser != "" && lastAssistant != "" {
				break
			}
		}

		// Build event summaries.
		eventSummaries := make([]map[string]any, 0, len(recentEvents))
		for _, ev := range recentEvents {
			m := map[string]any{
				"event_type": ev.EventType,
				"timestamp":  ev.Timestamp,
			}
			if ev.UserText != "" {
				m["user_text"] = truncate(ev.UserText, 200)
			}
			if ev.AssistantText != "" {
				m["assistant_text"] = truncate(ev.AssistantText, 200)
			}
			if ev.ToolName != "" {
				m["tool_name"] = ev.ToolName
			}
			if ev.ToolInput != "" {
				m["tool_input"] = truncate(ev.ToolInput, 200)
			}
			eventSummaries = append(eventSummaries, m)
		}

		// Build decision summaries.
		decisionSummaries := make([]map[string]any, 0, len(decisions))
		for _, d := range decisions {
			dm := map[string]any{
				"timestamp": d.Timestamp,
				"topic":     d.Topic,
				"decision":  d.DecisionText,
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
			decisionSummaries = append(decisionSummaries, dm)
		}

		// Build parent session summaries.
		parentSummaries := make([]map[string]any, 0, len(chain))
		for _, ps := range chain {
			if ps.ID == sess.ID {
				continue
			}
			parentSummaries = append(parentSummaries, map[string]any{
				"session_id": ps.ID,
				"summary":    ps.Summary,
				"turns":      ps.TurnCount,
			})
		}

		result := map[string]any{
			"session_id":             sess.ID,
			"project":               sess.ProjectName,
			"summary":               sess.Summary,
			"turn_count":            sess.TurnCount,
			"compact_count":         sess.CompactCount,
			"last_user_message":     truncate(lastUser, 300),
			"last_assistant_message": truncate(lastAssistant, 300),
			"recent_events":         eventSummaries,
			"decisions":             decisionSummaries,
			"files_modified":        filesModified,
			"parent_sessions":       parentSummaries,
		}

		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func recallHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		query := req.GetString("query", "")
		if query == "" {
			return mcp.NewToolResultError("query parameter is required"), nil
		}

		sessionID := req.GetString("session_id", "")
		segment := req.GetInt("segment", 0)
		limit := req.GetInt("limit", 10)
		if limit < 1 {
			limit = 10
		}

		// If no session_id, use the latest session.
		if sessionID == "" {
			sess, err := st.GetLatestSession("")
			if err != nil {
				return mcp.NewToolResultError("no sessions found: " + err.Error()), nil
			}
			sessionID = sess.ID
		}

		events, total, err := st.SearchEvents(query, sessionID, segment, limit)
		if err != nil {
			return mcp.NewToolResultError("search failed: " + err.Error()), nil
		}

		matchedEvents := make([]map[string]any, 0, len(events))
		for _, ev := range events {
			m := map[string]any{
				"event_type": ev.EventType,
				"timestamp":  ev.Timestamp,
			}
			if ev.UserText != "" {
				m["text"] = ev.UserText
			} else if ev.AssistantText != "" {
				m["text"] = ev.AssistantText
			}
			if ev.ToolName != "" {
				m["tool_name"] = ev.ToolName
			}
			if ev.ToolInput != "" {
				m["tool_input"] = truncate(ev.ToolInput, 500)
			}
			matchedEvents = append(matchedEvents, m)
		}

		result := map[string]any{
			"session_id":      sessionID,
			"compact_segment": segment,
			"query":           query,
			"matched_events":  matchedEvents,
			"total_matches":   total,
		}

		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func decisionsHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		sessionID := req.GetString("session_id", "")
		project := req.GetString("project", "")
		query := req.GetString("query", "")
		limit := req.GetInt("limit", 20)
		if limit < 1 {
			limit = 20
		}

		var decisions []store.DecisionRow
		var err error

		if query != "" {
			decisions, err = st.SearchDecisions(query, sessionID, limit)
		} else {
			decisions, err = st.GetDecisions(sessionID, project, limit)
		}
		if err != nil {
			return mcp.NewToolResultError("failed to get decisions: " + err.Error()), nil
		}

		decisionList := make([]map[string]any, 0, len(decisions))
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
			decisionList = append(decisionList, dm)
		}

		result := map[string]any{
			"project":         project,
			"total_decisions": len(decisions),
			"decisions":       decisionList,
		}

		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func levelString(l analyzer.FeedbackLevel) string {
	switch l {
	case analyzer.LevelLow:
		return "low"
	case analyzer.LevelInsight:
		return "insight"
	case analyzer.LevelWarning:
		return "warning"
	case analyzer.LevelAction:
		return "action"
	default:
		return "info"
	}
}

// truncate shortens a string to maxLen runes, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}
