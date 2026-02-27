package mcpserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/parser"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

type UsageHint struct {
	Category    string `json:"category"`
	Observation string `json:"observation"`
	Evidence    string `json:"evidence,omitempty"`
}

type FeatureUtil struct {
	PlanModeUsed  bool `json:"plan_mode_used"`
	SubagentUsed  bool `json:"subagent_used"`
	CLAUDEMDRead  bool `json:"claude_md_read"`
	SkillsUsed    bool `json:"skills_used"`
}

type Recommendation struct {
	Priority    int    `json:"priority"`
	Category    string `json:"category"`
	Severity    string `json:"severity"`
	Observation string `json:"observation"`
	Suggestion  string `json:"suggestion"`
	Evidence    string `json:"evidence,omitempty"`
}

func suggestHandler(claudeHome string, lang locale.Lang) server.ToolHandlerFunc {
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
		det := analyzer.NewDetector(lang.Code)
		for _, ev := range detail.Events {
			stats.Update(ev)
			det.Update(ev)
		}

		features := TrackFeatures(detail.Events)
		hints := ComputeUsageHints(detail.Events, stats)
		activeAlerts := det.ActiveAlerts()
		recs := BuildRecommendations(hints, features, activeAlerts)

		alertList := make([]map[string]any, 0, len(activeAlerts))
		for _, a := range activeAlerts {
			alertList = append(alertList, map[string]any{
				"pattern": analyzer.PatternName(a.Pattern),
				"level":   levelString(a.Level),
				"observation": a.Observation,
			})
		}

		sid := target.SessionID
		if len(sid) > 8 {
			sid = sid[:8]
		}

		result := map[string]any{
			"session_id":          sid,
			"session_health":      det.SessionHealth(),
			"active_alerts":       alertList,
			"usage_hints":         hints,
			"feature_utilization": features,
			"recommendations":     recs,
		}

		return marshalResult(result)
	}
}

// trackFeatures scans events for Claude Code feature usage.
func TrackFeatures(events []parser.SessionEvent) FeatureUtil {
	var f FeatureUtil
	for _, ev := range events {
		if ev.Type != parser.EventToolUse {
			continue
		}
		switch ev.ToolName {
		case "Read":
			if strings.Contains(ev.ToolInput, "CLAUDE.md") {
				f.CLAUDEMDRead = true
			}
			if strings.Contains(ev.ToolInput, ".claude/") {
				f.SkillsUsed = true
			}
		case "Skill":
			f.SkillsUsed = true
		case "EnterPlanMode":
			f.PlanModeUsed = true
		case "Task":
			f.SubagentUsed = true
		}
	}
	return f
}

// computeUsageHints analyzes events for usage quality signals.
func ComputeUsageHints(events []parser.SessionEvent, stats analyzer.Stats) []UsageHint {
	var hints []UsageHint

	// Short messages (vague instructions).
	shortCount, totalUser := 0, 0
	var shortTurns []int
	turnNum := 0
	for _, ev := range events {
		if ev.Type == parser.EventUserMessage {
			turnNum++
			totalUser++
			if len([]rune(ev.UserText)) < 20 {
				shortCount++
				shortTurns = append(shortTurns, turnNum)
			}
		}
	}
	if totalUser > 2 && shortCount > totalUser/2 {
		hints = append(hints, UsageHint{
			Category:    "instruction_quality",
			Observation: fmt.Sprintf("%d/%d user messages are under 20 chars (vague instructions)", shortCount, totalUser),
			Evidence:    fmt.Sprintf("Turn %s", formatTurns(shortTurns, 5)),
		})
	}

	// Multi-file changes without Plan Mode.
	planModeActive := false
	maxFilesInBurst := 0
	burstFiles := make(map[string]bool)
	worstTurn := 0
	turnNum = 0
	for _, ev := range events {
		switch ev.Type {
		case parser.EventUserMessage:
			turnNum++
			if len(burstFiles) > maxFilesInBurst {
				maxFilesInBurst = len(burstFiles)
				if !planModeActive && maxFilesInBurst >= 5 {
					worstTurn = turnNum - 1
				}
			}
			burstFiles = make(map[string]bool)
		case parser.EventToolUse:
			switch ev.ToolName {
			case "Write", "Edit":
				burstFiles[ev.ToolInput] = true
			case "EnterPlanMode":
				planModeActive = true
			case "ExitPlanMode":
				planModeActive = false
			}
		}
	}
	if len(burstFiles) > maxFilesInBurst {
		maxFilesInBurst = len(burstFiles)
	}
	if maxFilesInBurst >= 5 && !planModeActive && worstTurn > 0 {
		hints = append(hints, UsageHint{
			Category:    "plan_mode",
			Observation: fmt.Sprintf("%d files modified without Plan Mode", maxFilesInBurst),
			Evidence:    fmt.Sprintf("Turn %d", worstTurn),
		})
	}

	// Tool burst size.
	maxBurst := 0
	currentBurst := 0
	for _, ev := range events {
		if ev.Type == parser.EventUserMessage {
			if currentBurst > maxBurst {
				maxBurst = currentBurst
			}
			currentBurst = 0
		} else if ev.Type == parser.EventToolUse {
			currentBurst++
		}
	}
	if currentBurst > maxBurst {
		maxBurst = currentBurst
	}
	if maxBurst > 20 {
		hints = append(hints, UsageHint{
			Category:    "tool_efficiency",
			Observation: fmt.Sprintf("Max consecutive tools without user input: %d", maxBurst),
		})
	}

	// Compaction count.
	compactCount := 0
	for _, ev := range events {
		if ev.Type == parser.EventCompactBoundary {
			compactCount++
		}
	}
	if compactCount >= 2 {
		hints = append(hints, UsageHint{
			Category:    "context_management",
			Observation: fmt.Sprintf("Session compacted %d times (context loss risk)", compactCount),
		})
	}

	return hints
}

// BuildRecommendations generates prioritized recommendations from hints, features, and alerts.
func BuildRecommendations(hints []UsageHint, features FeatureUtil, alerts []analyzer.Alert) []Recommendation {
	var recs []Recommendation
	priority := 0

	// Alerts first (highest priority).
	for _, a := range alerts {
		if a.Level >= analyzer.LevelWarning {
			priority++
			recs = append(recs, Recommendation{
				Priority:    priority,
				Category:    "anti_pattern",
				Severity:    levelString(a.Level),
				Observation: a.Observation,
				Suggestion:  a.Suggestion,
			})
		}
	}

	// Hints as recommendations.
	for _, h := range hints {
		priority++
		sev := "info"
		var suggestion string
		switch h.Category {
		case "plan_mode":
			sev = "warning"
			suggestion = "Use EnterPlanMode before multi-file changes to confirm approach first"
		case "instruction_quality":
			sev = "insight"
			suggestion = "Include specific file paths and expected behavior in your instructions"
		case "context_management":
			sev = "warning"
			suggestion = "Consider splitting long sessions or summarizing key decisions before compact"
		case "tool_efficiency":
			sev = "insight"
			suggestion = "Add intermediate checkpoints — review progress between long tool chains"
		}
		if suggestion != "" {
			recs = append(recs, Recommendation{
				Priority:    priority,
				Category:    h.Category,
				Severity:    sev,
				Observation: h.Observation,
				Suggestion:  suggestion,
				Evidence:    h.Evidence,
			})
		}
	}

	// Feature utilization suggestions.
	if !features.PlanModeUsed && !features.SubagentUsed {
		priority++
		recs = append(recs, Recommendation{
			Priority:    priority,
			Category:    "feature_suggestion",
			Severity:    "info",
			Observation: "Neither Plan Mode nor subagents (Task) used in this session",
			Suggestion:  "For complex tasks, use Plan Mode to outline approach; use Task to parallelize independent work",
		})
	}
	if !features.CLAUDEMDRead {
		priority++
		recs = append(recs, Recommendation{
			Priority:    priority,
			Category:    "feature_suggestion",
			Severity:    "info",
			Observation: "CLAUDE.md not referenced in this session",
			Suggestion:  "Maintain a CLAUDE.md with project conventions to give Claude persistent context",
		})
	}

	return recs
}

// formatTurns formats a slice of turn numbers for display.
func formatTurns(turns []int, max int) string {
	if len(turns) == 0 {
		return ""
	}
	show := turns
	if len(show) > max {
		show = show[:max]
	}
	parts := make([]string, len(show))
	for i, t := range show {
		parts[i] = fmt.Sprintf("%d", t)
	}
	s := strings.Join(parts, ", ")
	if len(turns) > max {
		s += fmt.Sprintf(" (+%d more)", len(turns)-max)
	}
	return s
}
