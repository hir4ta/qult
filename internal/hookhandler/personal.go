package hookhandler

import (
	"encoding/json"
	"fmt"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// PersonalStats aggregates user-specific data from multiple sources
// for personalization across briefings, coaching, and delivery.
// Zero value is safe: all consumers check SessionCount before using data.
type PersonalStats struct {
	SuccessMedianTools int       // median tool count in successful sessions
	FailMedianTools    int       // median tool count in failed sessions
	TestFrequency      float64   // EWMA of test frequency (0-1)
	ReadWriteRatio     float64   // EWMA of read/write ratio
	CurrentPace        float64   // current session tools / past median
	RecurringStruggles []string  // top 3 recurring failure patterns
	SessionCount       int       // total project sessions (0 = insufficient data)
	Cluster            string    // conservative / balanced / aggressive
	AvgToolsPerSession float64   // average tool uses per session
}

const personalStatsKey = "personal_stats_cache"

// personalContext builds PersonalStats from persistent store + sessiondb.
// Results are cached in sessiondb for the lifetime of the hook process.
// Returns zero-value PersonalStats (SessionCount=0) when data is insufficient.
func personalContext(sdb *sessiondb.SessionDB) *PersonalStats {
	// Check sessiondb cache first.
	if cached, _ := sdb.GetContext(personalStatsKey); cached != "" {
		var ps PersonalStats
		if json.Unmarshal([]byte(cached), &ps) == nil {
			return &ps
		}
	}

	ps := &PersonalStats{
		Cluster: "balanced",
	}

	st, err := store.OpenDefault()
	if err != nil {
		cachePersonalStats(sdb, ps)
		return ps
	}
	defer st.Close()

	// User cluster.
	ps.Cluster = st.UserCluster()

	// Project session stats.
	projectPath, _ := sdb.GetWorkingSet("project_path")
	if projectPath == "" {
		projectPath, _ = sdb.GetContext("project_path")
	}
	if stats, err := st.GetProjectSessionStats(projectPath); err == nil && stats != nil {
		ps.SessionCount = stats.TotalSessions
		if stats.TotalSessions > 0 {
			ps.AvgToolsPerSession = float64(stats.TotalToolUses) / float64(stats.TotalSessions)
		}
	}

	// EWMA metrics from user profile.
	if metrics, err := st.AllUserProfile(); err == nil {
		for _, m := range metrics {
			switch m.MetricName {
			case "test_frequency":
				ps.TestFrequency = m.EWMAValue
			case "read_write_ratio":
				ps.ReadWriteRatio = m.EWMAValue
			case "tools_per_burst":
				if ps.AvgToolsPerSession > 0 {
					ps.CurrentPace = m.EWMAValue / ps.AvgToolsPerSession
				}
			}
		}
	}

	// Median tool counts from session history.
	if ps.SessionCount >= 3 {
		ps.SuccessMedianTools, ps.FailMedianTools = computeSessionMedians(st, projectPath)
	}

	// Recurring struggles from failure_solutions.
	ps.RecurringStruggles = findRecurringStruggles(st, 3)

	cachePersonalStats(sdb, ps)
	return ps
}

// cachePersonalStats stores PersonalStats in sessiondb to avoid repeated DB queries.
func cachePersonalStats(sdb *sessiondb.SessionDB, ps *PersonalStats) {
	data, err := json.Marshal(ps)
	if err != nil {
		return
	}
	_ = sdb.SetContext(personalStatsKey, string(data))
}

// computeSessionMedians returns median tool counts for successful and failed sessions.
// A session is considered "failed" if it had compactions (proxy for overrun).
func computeSessionMedians(st *store.Store, projectPath string) (successMedian, failMedian int) {
	rows, err := st.DB().Query(`
		SELECT tool_use_count, compact_count
		FROM sessions
		WHERE project_path = ? AND tool_use_count > 0
		ORDER BY last_event_at DESC
		LIMIT 50`, projectPath)
	if err != nil {
		return 0, 0
	}
	defer rows.Close()

	var successTools, failTools []int
	for rows.Next() {
		var tools, compacts int
		if rows.Scan(&tools, &compacts) != nil {
			continue
		}
		if compacts > 0 {
			failTools = append(failTools, tools)
		} else {
			successTools = append(successTools, tools)
		}
	}

	return median(successTools), median(failTools)
}

// median returns the median of a sorted int slice.
func median(vals []int) int {
	if len(vals) == 0 {
		return 0
	}
	// Simple insertion sort for small slices.
	sorted := make([]int, len(vals))
	copy(sorted, vals)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	return sorted[len(sorted)/2]
}

// findRecurringStruggles returns the top N most frequent failure types
// from the failure_solutions table.
func findRecurringStruggles(st *store.Store, limit int) []string {
	rows, err := st.DB().Query(`
		SELECT failure_type, COUNT(*) as cnt
		FROM failure_solutions
		GROUP BY failure_type
		HAVING cnt >= 2
		ORDER BY cnt DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var struggles []string
	for rows.Next() {
		var ftype string
		var cnt int
		if rows.Scan(&ftype, &cnt) == nil && ftype != "" {
			struggles = append(struggles, fmt.Sprintf("%s (%dx)", ftype, cnt))
		}
	}
	return struggles
}
