package mcpserver

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
	"github.com/hir4ta/claude-alfred/internal/store"
)

func pendingNudgesHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		sid := req.GetString("session_id", "")
		if sid == "" {
			sid = latestSessionID(st)
		}
		if sid == "" || sid == "unknown" {
			return mcp.NewToolResultError("no active session found"), nil
		}

		sdb, err := sessiondb.Open(sid)
		if err != nil {
			return mcp.NewToolResultError("failed to open session: " + err.Error()), nil
		}
		defer sdb.Close()

		nudges, err := sdb.PeekNudges(10)
		if err != nil {
			return mcp.NewToolResultError("failed to read nudges: " + err.Error()), nil
		}

		pending := make([]map[string]any, 0)
		recent := make([]map[string]any, 0)
		for _, n := range nudges {
			entry := map[string]any{
				"pattern":     n.Pattern,
				"level":       n.Level,
				"observation": n.Observation,
				"suggestion":  n.Suggestion,
				"created_at":  n.CreatedAt.Format("2006-01-02 15:04:05"),
			}
			if n.Delivered {
				recent = append(recent, entry)
			} else {
				pending = append(pending, entry)
			}
		}

		// Enrich with working set context for relevance.
		workingSet := map[string]any{}
		if intent, _ := sdb.GetContext("intent"); intent != "" {
			workingSet["intent"] = intent
		}
		if taskType, _ := sdb.GetContext("task_type"); taskType != "" {
			workingSet["task_type"] = taskType
		}
		if files, _ := sdb.GetContext("modified_files"); files != "" {
			var fileList []string
			if json.Unmarshal([]byte(files), &fileList) == nil {
				workingSet["files"] = fileList
			}
		}
		if phase, _ := sdb.GetContext("workflow_phase"); phase != "" {
			workingSet["phase"] = phase
		}

		result := map[string]any{
			"pending_nudges":           pending,
			"recently_delivered":       recent,
			"pending_count":            len(pending),
			"recently_delivered_count": len(recent),
		}
		if len(workingSet) > 0 {
			result["working_context"] = workingSet
		}

		// Add summary for quick consumption.
		if len(pending) > 0 {
			var patterns []string
			for _, p := range pending {
				if pat, ok := p["pattern"].(string); ok {
					patterns = append(patterns, pat)
				}
			}
			summary := strings.Join(patterns, ", ")
			if sug, ok := pending[0]["suggestion"].(string); ok {
				summary += " — " + sug
			}
			result["summary"] = summary
		}

		return marshalResult(result)
	}
}
