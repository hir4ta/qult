package mcpserver

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/store"
)

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

		filesChanged, err := st.GetFilesWritten(sess.ID, 30)
		if err != nil {
			return mcp.NewToolResultError("failed to get files changed: " + err.Error()), nil
		}

		filesReferenced, err := st.GetFilesReadOnly(sess.ID, 30)
		if err != nil {
			return mcp.NewToolResultError("failed to get files referenced: " + err.Error()), nil
		}

		compactEvents, err := st.GetCompactEvents(sess.ID)
		if err != nil {
			return mcp.NewToolResultError("failed to get compact events: " + err.Error()), nil
		}

		chain, err := st.GetSessionChain(sess.ID)
		if err != nil {
			return mcp.NewToolResultError("failed to get session chain: " + err.Error()), nil
		}

		// Find last user message, last assistant message, and current intent.
		var lastUser, lastAssistant, currentIntent string
		for _, ev := range recentEvents {
			if lastUser == "" && ev.UserText != "" {
				lastUser = ev.UserText
			}
			if lastAssistant == "" && ev.AssistantText != "" {
				lastAssistant = ev.AssistantText
			}
			if currentIntent == "" && ev.EventType == 0 && ev.UserText != "" {
				if !strings.HasPrefix(ev.UserText, "User has answered") {
					currentIntent = ev.UserText
				}
			}
			if lastUser != "" && lastAssistant != "" && currentIntent != "" {
				break
			}
		}

		eventSummaries := buildEventSummaries(recentEvents)
		decisionSummaries := buildDecisionSummaries(decisions)
		compactionHistory := buildCompactionHistory(compactEvents)
		filesChangedList := buildFilesChanged(filesChanged)
		filesReferencedList := buildFilesReferenced(filesReferenced)
		parentSummaries := buildParentSessions(st, sess.ID, chain)

		result := map[string]any{
			"session_id":              sess.ID,
			"project":                sess.ProjectName,
			"initial_goal":           truncate(sess.FirstPrompt, 300),
			"current_intent":         truncate(currentIntent, 300),
			"turn_count":             sess.TurnCount,
			"compact_count":          sess.CompactCount,
			"compaction_history":     compactionHistory,
			"files_changed":          filesChangedList,
			"files_referenced":       filesReferencedList,
			"decisions":              decisionSummaries,
			"recent_events":          eventSummaries,
			"last_user_message":      truncate(lastUser, 300),
			"last_assistant_message": truncate(lastAssistant, 300),
			"parent_sessions":        parentSummaries,
		}

		data, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}
}

func buildEventSummaries(events []store.EventRow) []map[string]any {
	summaries := make([]map[string]any, 0, len(events))
	for _, ev := range events {
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
		summaries = append(summaries, m)
	}
	return summaries
}

func buildDecisionSummaries(decisions []store.DecisionRow) []map[string]any {
	summaries := make([]map[string]any, 0, len(decisions))
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
		summaries = append(summaries, dm)
	}
	return summaries
}

func buildCompactionHistory(compactEvents []store.CompactEventRow) []map[string]any {
	history := make([]map[string]any, 0, len(compactEvents))
	for _, ce := range compactEvents {
		history = append(history, map[string]any{
			"segment":   ce.SegmentIndex,
			"timestamp": ce.Timestamp,
			"summary":   ce.SummaryText,
			"pre_turns": ce.PreTurnCount,
			"pre_tools": ce.PreToolCount,
		})
	}
	return history
}

func buildFilesChanged(files []store.FileActivity) []map[string]any {
	list := make([]map[string]any, 0, len(files))
	for _, fa := range files {
		list = append(list, map[string]any{
			"path":   fa.Path,
			"action": fa.Action,
			"count":  fa.Count,
		})
	}
	return list
}

func buildFilesReferenced(files []store.FileActivity) []map[string]any {
	list := make([]map[string]any, 0, len(files))
	for _, fa := range files {
		list = append(list, map[string]any{
			"path":  fa.Path,
			"count": fa.Count,
		})
	}
	return list
}

func buildParentSessions(st *store.Store, currentID string, chain []store.SessionRow) []map[string]any {
	summaries := make([]map[string]any, 0, len(chain))
	for _, ps := range chain {
		if ps.ID == currentID {
			continue
		}
		pm := map[string]any{
			"session_id": ps.ID,
			"summary":    ps.Summary,
			"turns":      ps.TurnCount,
		}
		parentDecisions, pdErr := st.GetDecisions(ps.ID, "", 5)
		if pdErr == nil && len(parentDecisions) > 0 {
			pdList := make([]map[string]any, 0, len(parentDecisions))
			for _, pd := range parentDecisions {
				pdm := map[string]any{
					"topic":    truncate(pd.Topic, 200),
					"decision": truncate(pd.DecisionText, 200),
				}
				if pd.Reasoning != "" {
					pdm["reasoning"] = truncate(pd.Reasoning, 200)
				}
				pdList = append(pdList, pdm)
			}
			pm["decisions"] = pdList
		}
		summaries = append(summaries, pm)
	}
	return summaries
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
