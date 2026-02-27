package hookhandler

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// strategicInsight represents a high-level behavioral observation
// derived from cross-session data. Unlike tactical suggestions ("fix this test"),
// strategic insights address patterns across sessions ("you always compact on auth tasks").
type strategicInsight struct {
	category string // trend, pace, pattern, momentum, trajectory
	message  string
	priority int // lower = higher priority
}

// generateStrategicInsight produces personalized strategic guidance
// from cross-session behavioral data. This is the "JARVIS upper body":
// personal, proactive, strategic — using data the user can't see themselves.
func generateStrategicInsight(sdb *sessiondb.SessionDB, projectPath string) string {
	on, _ := sdb.IsOnCooldown("strategic_insight")
	if on {
		return ""
	}

	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

	// Need sufficient history for meaningful insights.
	stats, err := st.GetProjectSessionStats(projectPath)
	if err != nil || stats.TotalSessions < 3 {
		return ""
	}

	taskTypeStr, _ := sdb.GetContext("task_type")
	taskType := TaskType(taskTypeStr)

	var insights []strategicInsight

	if insight := behavioralTrend(st); insight != nil {
		insights = append(insights, *insight)
	}
	if insight := sessionPaceInsight(sdb, st, taskType, projectPath); insight != nil {
		insights = append(insights, *insight)
	}
	if insight := recurringStruggle(st, projectPath); insight != nil {
		insights = append(insights, *insight)
	}
	if insight := momentumInsight(sdb); insight != nil {
		insights = append(insights, *insight)
	}
	if insight := trajectoryWarning(sdb, st, taskType); insight != nil {
		insights = append(insights, *insight)
	}

	if len(insights) == 0 {
		return ""
	}

	sort.Slice(insights, func(i, j int) bool {
		return insights[i].priority < insights[j].priority
	})

	_ = sdb.SetCooldown("strategic_insight", 15*time.Minute)

	// Deliver the single most impactful insight.
	return insights[0].message
}

// behavioralTrend detects actionable patterns in the user's coding behavior
// by examining profile metrics against ideal ranges.
func behavioralTrend(st *store.Store) *strategicInsight {
	metrics, err := st.AllUserProfile()
	if err != nil || len(metrics) == 0 {
		return nil
	}

	metricMap := make(map[string]store.UserProfileMetric)
	for _, m := range metrics {
		metricMap[m.MetricName] = m
	}

	// Test frequency: low testing correlates with longer debug cycles.
	if tf, ok := metricMap["test_frequency"]; ok && tf.SampleCount >= 5 {
		if tf.EWMAValue < 0.3 {
			return &strategicInsight{
				category: "trend",
				message: fmt.Sprintf(
					"Test frequency is %.0f%% across recent sessions. Adding a test run per implementation burst catches regressions early.",
					tf.EWMAValue*100),
				priority: 1,
			}
		}
	}

	// Read/write ratio: extreme values indicate workflow imbalance.
	if rw, ok := metricMap["read_write_ratio"]; ok && rw.SampleCount >= 5 {
		if rw.EWMAValue > 4.0 {
			return &strategicInsight{
				category: "trend",
				message: fmt.Sprintf(
					"Read/write ratio is %.1f:1 — reading far more than writing. Try implementing a small piece to build momentum.",
					rw.EWMAValue),
				priority: 2,
			}
		}
		if rw.EWMAValue < 1.0 {
			return &strategicInsight{
				category: "trend",
				message: fmt.Sprintf(
					"Read/write ratio is %.1f:1 — writing more than reading. Reading related code and tests before editing reduces rework.",
					rw.EWMAValue),
				priority: 2,
			}
		}
	}

	// Compact frequency: high compaction means tasks are too large per session.
	if cf, ok := metricMap["compact_frequency"]; ok && cf.SampleCount >= 5 {
		if cf.EWMAValue > 0.5 {
			return &strategicInsight{
				category: "trend",
				message: "Context compaction is happening frequently. Break tasks into smaller units — each session should target one clear outcome.",
				priority: 1,
			}
		}
	}

	return nil
}

// sessionPaceInsight compares current session progress against the historical
// median for the same task type. Flags when the session is running long
// without key milestones (tests, commits).
func sessionPaceInsight(sdb *sessiondb.SessionDB, st *store.Store, taskType TaskType, projectPath string) *strategicInsight {
	if taskType == TaskUnknown {
		return nil
	}

	workflows, err := st.GetSuccessfulWorkflows(projectPath, string(taskType), 20)
	if err != nil || len(workflows) < 3 {
		return nil
	}

	// Median tool count from past successes.
	toolCounts := make([]int, len(workflows))
	for i, w := range workflows {
		toolCounts[i] = w.ToolCount
	}
	sort.Ints(toolCounts)
	median := toolCounts[len(toolCounts)/2]

	currentTools := FlowEventCount(sdb)
	if currentTools < 15 || median < 10 {
		return nil
	}

	ratio := float64(currentTools) / float64(median)
	if ratio > 1.5 {
		hasTest, _ := sdb.GetContext("has_test_run")
		testNote := ""
		if hasTest != "true" {
			testNote = " No tests run yet."
		}
		return &strategicInsight{
			category: "pace",
			message: fmt.Sprintf(
				"This %s session: %d tools used (successful sessions median: %d).%s Consider committing progress or pivoting approach.",
				taskType, currentTools, median, testNote),
			priority: 0,
		}
	}

	return nil
}

// recurringStruggle detects files or error types that repeatedly cause failures
// across sessions. Suggests structural fixes over repeated patches.
func recurringStruggle(st *store.Store, projectPath string) *strategicInsight {
	if projectPath == "" {
		return nil
	}

	failures, err := st.FrequentFailures(projectPath, 5)
	if err != nil || len(failures) == 0 {
		return nil
	}

	for _, f := range failures {
		if f.Count >= 3 {
			fileName := f.FilePath
			if idx := strings.LastIndex(fileName, "/"); idx >= 0 {
				fileName = fileName[idx+1:]
			}
			return &strategicInsight{
				category: "pattern",
				message: fmt.Sprintf(
					"%s failures on %s: %d times across sessions. A structural fix may be more effective than patching each occurrence.",
					f.FailureType, fileName, f.Count),
				priority: 1,
			}
		}
	}

	return nil
}

// momentumInsight provides companion-style feedback based on velocity trends.
// Acknowledges good flow and warns about declining momentum.
func momentumInsight(sdb *sessiondb.SessionDB) *strategicInsight {
	trend := PredictHealthTrend(sdb)
	if trend == nil {
		return nil
	}

	flow := classifyFlowState(sdb)

	switch {
	case flow == FlowProductive && trend.Trend == "improving":
		eventCount := FlowEventCount(sdb)
		if eventCount >= 20 {
			return &strategicInsight{
				category: "momentum",
				message: fmt.Sprintf(
					"Strong flow — %d tools at %.0f%% health, trend improving. Stay focused.",
					eventCount, trend.CurrentHealth*100),
				priority: 3,
			}
		}
	case trend.Trend == "declining" && trend.ToolsToThreshold > 0 && trend.ToolsToThreshold < 30:
		return &strategicInsight{
			category: "momentum",
			message: fmt.Sprintf(
				"Health declining (%.0f%%, slope %.2f/10 tools). At this rate, ~%d tools until threshold. Consider stepping back to reassess.",
				trend.CurrentHealth*100, trend.Slope, trend.ToolsToThreshold),
			priority: 0,
		}
	}

	return nil
}

// trajectoryWarning checks if the current session's phase sequence matches
// past failed sessions (Jaccard similarity on phase bigrams).
func trajectoryWarning(sdb *sessiondb.SessionDB, st *store.Store, taskType TaskType) *strategicInsight {
	if taskType == TaskUnknown {
		return nil
	}

	phases, err := sdb.GetRawPhaseSequence(15)
	if err != nil || len(phases) < 4 {
		return nil
	}

	_, similarity, err := st.MatchesWorkflowTrajectory(string(taskType), phases)
	if err != nil || similarity < 0.6 {
		return nil
	}

	return &strategicInsight{
		category: "trajectory",
		message: fmt.Sprintf(
			"Current workflow trajectory is %.0f%% similar to a past failed %s session. Consider changing approach — different phase ordering or breaking the problem down differently.",
			similarity*100, taskType),
		priority: 0,
	}
}
