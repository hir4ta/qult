package mcpserver

import (
	"context"
	"fmt"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

// sessionOutlookHandler provides a holistic view of the current session:
// health score, phase progress, risk assessment, and actionable next steps.
func sessionOutlookHandler(claudeHome string, st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		sessions, err := watcher.ListSessions(claudeHome)
		if err != nil || len(sessions) == 0 {
			return mcp.NewToolResultError("no sessions found"), nil
		}
		target := sessions[0]

		detail, err := watcher.LoadSessionDetail(target)
		if err != nil {
			return mcp.NewToolResultError("failed to load session: " + err.Error()), nil
		}

		stats := analyzer.NewStats()
		det := analyzer.NewDetector()
		for _, ev := range detail.Events {
			stats.Update(ev)
			det.Update(ev)
		}

		health := det.SessionHealth()
		alerts := det.ActiveAlerts()

		// Build outlook.
		result := map[string]any{
			"session_id":    shortID(target.SessionID),
			"health_score":  health,
			"duration_min":  int(stats.Elapsed().Minutes()),
			"turns":         stats.TurnCount,
			"tool_uses":     stats.ToolUseCount,
			"tools_per_turn": stats.ToolsPerTurn(),
		}

		// Active alerts.
		alertList := make([]string, 0, len(alerts))
		for _, a := range alerts {
			alertList = append(alertList, fmt.Sprintf("[%s] %s",
				levelString(a.Level), a.Observation))
		}
		result["alerts"] = alertList

		// Phase progress from sessiondb.
		phase, taskType, recommendations := sessionPhaseInfo(target.SessionID, st)
		result["current_phase"] = phase
		result["task_type"] = taskType
		result["recommendations"] = recommendations

		// Risk assessment.
		result["risk_level"] = assessRisk(health, len(alerts), stats.ToolUseCount)

		// Signal-to-noise ratio from suggestion outcomes (30-day window).
		if st != nil {
			snr, sampleSize, snrErr := st.ComputeSNR(30)
			if snrErr == nil && sampleSize > 0 {
				result["snr"] = snr
				result["snr_sample_size"] = sampleSize
			}
		}

		// User profile context.
		if st != nil {
			cluster := st.UserCluster()
			result["user_style"] = cluster
		}

		return marshalResult(result)
	}
}

// taskProgressHandler tracks progress across sessions for a task/project.
func taskProgressHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		project := req.GetString("project", "")
		sessionID := req.GetString("session_id", "")

		result := map[string]any{}

		// Project-level stats.
		if project != "" {
			projStats, err := st.GetProjectSessionStats(project)
			if err == nil && projStats != nil {
				result["project_stats"] = map[string]any{
					"total_sessions":        projStats.TotalSessions,
					"total_turns":           projStats.TotalTurns,
					"total_tool_uses":       projStats.TotalToolUses,
					"avg_turns_per_session": fmt.Sprintf("%.1f", projStats.AvgTurnsPerSession),
					"avg_compacts_per_sess": fmt.Sprintf("%.1f", projStats.AvgCompactsPerSess),
				}
			}
		}

		// Session chain (multi-session continuity).
		if sessionID != "" {
			chain, _ := st.GetSessionChain(sessionID)
			chainSummary := make([]map[string]any, 0, len(chain))
			for _, s := range chain {
				entry := map[string]any{
					"session_id": shortID(s.ID),
					"turns":      s.TurnCount,
					"tools":      s.ToolUseCount,
					"started":    s.FirstEventAt,
				}
				if s.Summary != "" {
					summary := s.Summary
					if len([]rune(summary)) > 150 {
						summary = string([]rune(summary)[:150]) + "..."
					}
					entry["summary"] = summary
				}
				chainSummary = append(chainSummary, entry)
			}
			result["session_chain"] = chainSummary
		}

		// Decisions across sessions.
		decisions, _ := st.GetDecisions(sessionID, project, 10)
		decList := make([]map[string]any, 0, len(decisions))
		for _, d := range decisions {
			text := d.DecisionText
			if len([]rune(text)) > 120 {
				text = string([]rune(text)[:120]) + "..."
			}
			decList = append(decList, map[string]any{
				"session":  shortID(d.SessionID),
				"decision": text,
				"topic":    truncateRunes(d.Topic, 80),
			})
		}
		result["decisions"] = decList

		// Workflow patterns for this project.
		taskType := req.GetString("task_type", "")
		if taskType != "" {
			workflows, _ := st.GetSuccessfulWorkflows(project, taskType, 5)
			wfList := make([]map[string]any, 0, len(workflows))
			for _, wf := range workflows {
				wfList = append(wfList, map[string]any{
					"phases":    wf.PhaseSequence,
					"tools":     wf.ToolCount,
					"duration":  wf.DurationSec,
					"succeeded": wf.Success,
				})
			}
			result["workflow_history"] = wfList

			// Most common successful pattern.
			common, count, _ := st.MostCommonWorkflow(project, taskType, 3)
			if len(common) > 0 {
				result["recommended_workflow"] = map[string]any{
					"phases":    common,
					"based_on":  count,
					"task_type": taskType,
				}
			}
		}

		// Frequent failure patterns.
		failures := frequentFailuresSummary(st, project)
		if len(failures) > 0 {
			result["common_failures"] = failures
		}

		return marshalResult(result)
	}
}

// strategicPlanHandler recommends an optimal workflow based on task type,
// past patterns, user style, and predicted tool sequences.
func strategicPlanHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		taskType := req.GetString("task_type", "")
		if taskType == "" {
			return mcp.NewToolResultError("task_type parameter is required"), nil
		}
		project := req.GetString("project", "")

		result := map[string]any{
			"task_type": taskType,
		}

		// 1. Recommended phase sequence.
		common, count, _ := st.MostCommonWorkflow(project, taskType, 3)
		if len(common) > 0 {
			result["recommended_phases"] = common
			result["confidence_sessions"] = count
		} else {
			result["recommended_phases"] = defaultWorkflow(taskType)
			result["confidence_sessions"] = 0
		}

		// 2. Estimated effort from past workflows.
		workflows, _ := st.GetSuccessfulWorkflows(project, taskType, 20)
		if len(workflows) > 0 {
			totalTools := 0
			totalDuration := 0
			for _, wf := range workflows {
				totalTools += wf.ToolCount
				totalDuration += wf.DurationSec
			}
			result["estimated_tools"] = totalTools / len(workflows)
			result["estimated_duration_min"] = (totalDuration / len(workflows)) / 60
		}

		// 3. User style adaptation.
		cluster := st.UserCluster()
		result["user_style"] = cluster
		result["style_advice"] = clusterAdvice(cluster, taskType)

		// 4. Risk factors from past failures.
		failedWorkflows, _ := st.GetFailedWorkflows(taskType, 5)
		if len(failedWorkflows) > 0 {
			var riskPhases []string
			phaseCounts := make(map[string]int)
			for _, wf := range failedWorkflows {
				for _, p := range wf.PhaseSequence {
					phaseCounts[p]++
				}
			}
			for phase, cnt := range phaseCounts {
				if cnt >= 2 {
					riskPhases = append(riskPhases, fmt.Sprintf("%s (%d failures)", phase, cnt))
				}
			}
			if len(riskPhases) > 0 {
				result["risk_phases"] = riskPhases
			}
		}

		// 5. Common failures to watch for.
		failures := frequentFailuresSummary(st, project)
		if len(failures) > 0 {
			result["common_failures"] = failures
		}

		// 6. Tool sequence predictions.
		preds, _ := st.PredictNextToolGlobal("Read", 3)
		if len(preds) > 0 {
			predList := make([]map[string]any, 0, len(preds))
			for _, p := range preds {
				predList = append(predList, map[string]any{
					"tool":         p.Tool,
					"frequency":    p.Count,
					"success_rate": fmt.Sprintf("%.0f%%", p.SuccessRate*100),
				})
			}
			result["after_read_predictions"] = predList
		}

		return marshalResult(result)
	}
}

// --- Helpers ---

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "..."
	}
	return s
}

func sessionPhaseInfo(sessionID string, st *store.Store) (phase, taskType string, recommendations []string) {
	dbPath := sessiondb.DBPath(sessionID)
	if _, err := os.Stat(dbPath); err != nil {
		return "unknown", "", nil
	}
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		return "unknown", "", nil
	}
	defer sdb.Close()

	taskType, _ = sdb.GetContext("task_type")
	phase, _ = sdb.GetContext("prev_phase")
	if phase == "" {
		phase = "starting"
	}

	// Build recommendations based on phase + task type.
	switch phase {
	case "read":
		recommendations = append(recommendations, "You're in the exploration phase. Narrow down to specific files before editing.")
		if taskType == "bugfix" {
			recommendations = append(recommendations, "Reproduce the bug with a failing test before fixing.")
		}
	case "write":
		recommendations = append(recommendations, "You're implementing. Run tests after each significant change.")
		hasTestRun, _ := sdb.GetContext("has_test_run")
		if hasTestRun != "true" {
			recommendations = append(recommendations, "No tests run yet this session. Consider running tests soon.")
		}
	case "test":
		recommendations = append(recommendations, "You're in the testing phase. Focus on understanding failures before re-editing.")
	case "compile":
		recommendations = append(recommendations, "Fix compilation errors before running tests.")
	}

	// Check trajectory risk.
	if st != nil && taskType != "" {
		phases := getPhaseSeq(sdb)
		if len(phases) >= 3 {
			_, similarity, _ := st.MatchesWorkflowTrajectory(taskType, phases)
			if similarity >= 0.7 {
				recommendations = append(recommendations,
					fmt.Sprintf("Your session trajectory is %.0f%% similar to a past failure. Consider a different approach.", similarity*100))
			}
		}
	}

	return phase, taskType, recommendations
}

func getPhaseSeq(sdb *sessiondb.SessionDB) []string {
	phases, _ := sdb.GetRawPhaseSequence(20)
	return phases
}

func assessRisk(health float64, alertCount, toolCount int) string {
	switch {
	case health < 0.4 || alertCount >= 3:
		return "high"
	case health < 0.7 || alertCount >= 1 || toolCount > 50:
		return "medium"
	default:
		return "low"
	}
}

func defaultWorkflow(taskType string) []string {
	switch taskType {
	case "bugfix":
		return []string{"read", "test", "write", "test"}
	case "feature":
		return []string{"read", "plan", "write", "test"}
	case "refactor":
		return []string{"read", "test", "write", "test"}
	case "test":
		return []string{"read", "write", "test"}
	case "explore":
		return []string{"read", "read", "plan"}
	default:
		return []string{"read", "write", "test"}
	}
}

func clusterAdvice(cluster, taskType string) string {
	switch cluster {
	case "conservative":
		return "Your style is methodical. This works well — keep reading before writing. For " + taskType + " tasks, your thorough approach prevents regressions."
	case "aggressive":
		switch taskType {
		case "bugfix":
			return "Your style is fast-moving. For bugfix tasks, consider adding a Read phase before editing — it reduces edit failures by ~40%."
		case "refactor":
			return "Your style is fast-moving. For refactoring, run the full test suite before AND after changes to catch subtle regressions."
		default:
			return "Your style is fast-moving. Consider adding a brief exploration phase to avoid rework."
		}
	default:
		return "Your style is balanced. Maintain your read-write-test rhythm."
	}
}

func frequentFailuresSummary(st *store.Store, project string) []map[string]any {
	failures, _ := st.FrequentFailures(project, 5)
	var result []map[string]any
	for _, f := range failures {
		sig := f.ErrorSignature
		if len([]rune(sig)) > 80 {
			sig = string([]rune(sig)[:80]) + "..."
		}
		result = append(result, map[string]any{
			"type":       f.FailureType,
			"signature":  sig,
			"occurrences": f.Count,
		})
	}
	return result
}
