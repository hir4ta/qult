package mcpserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/parser"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

func currentStateHandler(claudeHome string, lang locale.Lang) server.ToolHandlerFunc {
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

		// Compute stats and alerts from JSONL events.
		stats := analyzer.NewStats()
		det := analyzer.NewDetector(lang.Code)
		for _, ev := range detail.Events {
			stats.Update(ev)
			det.Update(ev)
		}

		sid := target.SessionID
		if len(sid) > 8 {
			sid = sid[:8]
		}

		// Stats section.
		topTools := stats.TopTools(5)
		toolList := make([]map[string]any, 0, len(topTools))
		for _, t := range topTools {
			toolList = append(toolList, map[string]any{
				"name":  t.Name,
				"count": t.Count,
			})
		}

		statsMap := map[string]any{
			"turns":        stats.TurnCount,
			"tool_uses":    stats.ToolUseCount,
			"tools_per_turn": stats.ToolsPerTurn(),
			"duration_min": int(stats.Elapsed().Minutes()),
			"top_tools":    toolList,
		}

		// Health section.
		activeAlerts := det.ActiveAlerts()
		alertList := make([]map[string]any, 0, len(activeAlerts))
		for _, a := range activeAlerts {
			alertList = append(alertList, map[string]any{
				"pattern": analyzer.PatternName(a.Pattern),
				"level":   levelString(a.Level),
			})
		}

		outcomes := det.RecentOutcomes()
		outcomeList := make([]map[string]any, 0, len(outcomes))
		for _, o := range outcomes {
			outcomeList = append(outcomeList, map[string]any{
				"pattern":  analyzer.PatternName(o.Pattern),
				"resolved": o.Resolved,
			})
		}

		healthMap := map[string]any{
			"score":          det.SessionHealth(),
			"active_alerts":  alertList,
			"alert_outcomes": outcomeList,
		}

		// Features from JSONL events.
		features := TrackFeatures(detail.Events)
		featuresMap := map[string]any{
			"plan_mode_active": false,
			"plan_mode_used":   features.PlanModeUsed,
			"subagent_active":  false,
			"subagent_used":    features.SubagentUsed,
			"claude_md_read":   features.CLAUDEMDRead,
			"skills_used":      features.SkillsUsed,
		}

		// Predictions from JSONL.
		compactCount := 0
		for _, ev := range detail.Events {
			if ev.Type == parser.EventCompactBoundary {
				compactCount++
			}
		}

		predictionsMap := map[string]any{
			"compact_count":              compactCount,
			"estimated_context_pressure": contextPressure(compactCount, stats.TurnCount),
		}

		// Try to read live burst state from sessiondb (may not exist).
		burstMap := readBurstState(target.SessionID, featuresMap)

		result := map[string]any{
			"session_id":  sid,
			"stats":       statsMap,
			"burst":       burstMap,
			"health":      healthMap,
			"predictions": predictionsMap,
			"features":    featuresMap,
		}

		return marshalResult(result)
	}
}

// readBurstState attempts to read live burst state from the ephemeral sessiondb.
// Returns nil if the sessiondb doesn't exist (session not active or hooks not installed).
func readBurstState(fullSessionID string, featuresMap map[string]any) map[string]any {
	dbPath := sessiondb.DBPath(fullSessionID)
	if _, err := os.Stat(dbPath); err != nil {
		return nil
	}

	sdb, err := sessiondb.Open(fullSessionID)
	if err != nil {
		return nil
	}
	defer sdb.Close()

	tc, hasWrite, fileReads, err := sdb.BurstState()
	if err != nil {
		return nil
	}

	startTime, _ := sdb.BurstStartTime()
	elapsed := 0
	if !startTime.IsZero() {
		elapsed = int(time.Since(startTime).Seconds())
	}

	// Update features with live mode context.
	if v, _ := sdb.GetContext("plan_mode"); v == "active" {
		featuresMap["plan_mode_active"] = true
	}
	if v, _ := sdb.GetContext("subagent_active"); v == "true" {
		featuresMap["subagent_active"] = true
	}

	// Top file reads.
	topReads := make(map[string]int)
	for f, c := range fileReads {
		topReads[filepath.Base(f)] = c
	}

	return map[string]any{
		"tool_count":  tc,
		"has_write":   hasWrite,
		"elapsed_sec": elapsed,
		"file_reads":  topReads,
	}
}

// contextPressure estimates context pressure based on compact frequency and turn count.
func contextPressure(compactCount, turnCount int) string {
	if compactCount == 0 {
		if turnCount > 30 {
			return "medium"
		}
		return "low"
	}
	turnsPerCompact := turnCount
	if compactCount > 0 {
		turnsPerCompact = turnCount / (compactCount + 1)
	}
	if compactCount >= 3 || turnsPerCompact < 10 {
		return "high"
	}
	if compactCount >= 1 {
		return "medium"
	}
	return "low"
}

// formatAnalyzeReport creates a terminal-friendly report from structured data.
func FormatAnalyzeReport(
	sid string,
	stats analyzer.Stats,
	det *analyzer.Detector,
	features FeatureUtil,
	hints []UsageHint,
	recs []Recommendation,
) string {
	var sb strings.Builder

	fmt.Fprintf(&sb, "Session: %s\n", sid)
	fmt.Fprintf(&sb, "Turns: %d | Tools: %d (%.1f/turn) | %dmin\n",
		stats.TurnCount, stats.ToolUseCount, stats.ToolsPerTurn(), int(stats.Elapsed().Minutes()))
	fmt.Fprintf(&sb, "Health: %.0f%%\n", det.SessionHealth()*100)

	if len(stats.TopTools(5)) > 0 {
		sb.WriteString("\nTop tools: ")
		var parts []string
		for _, t := range stats.TopTools(5) {
			parts = append(parts, fmt.Sprintf("%s(%d)", t.Name, t.Count))
		}
		sb.WriteString(strings.Join(parts, "  "))
		sb.WriteString("\n")
	}

	fmt.Fprintf(&sb, "\nFeatures: PlanMode=%v Subagent=%v CLAUDE.md=%v Skills=%v\n",
		features.PlanModeUsed, features.SubagentUsed, features.CLAUDEMDRead, features.SkillsUsed)

	activeAlerts := det.ActiveAlerts()
	if len(activeAlerts) > 0 {
		sb.WriteString("\nActive Alerts:\n")
		for _, a := range activeAlerts {
			fmt.Fprintf(&sb, "  [%s] %s: %s\n",
				analyzer.PatternName(a.Pattern), levelString(a.Level), a.Observation)
		}
	}

	if len(hints) > 0 {
		sb.WriteString("\nUsage Hints:\n")
		for _, h := range hints {
			fmt.Fprintf(&sb, "  [%s] %s", h.Category, h.Observation)
			if h.Evidence != "" {
				fmt.Fprintf(&sb, " (%s)", h.Evidence)
			}
			sb.WriteString("\n")
		}
	}

	if len(recs) > 0 {
		sb.WriteString("\nRecommendations:\n")
		for _, r := range recs {
			fmt.Fprintf(&sb, "  %d. [%s] %s\n     → %s\n",
				r.Priority, r.Severity, r.Observation, r.Suggestion)
		}
	}

	return sb.String()
}
