package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
	"github.com/hir4ta/claude-alfred/internal/store"
)

type sessionEndInput struct {
	CommonInput
	Reason string `json:"reason"`
}

func handleSessionEnd(input []byte) (*HookOutput, error) {
	var in sessionEndInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// Persist session knowledge (workflow, metrics, user profile, global sync).
	persistSessionData(in.SessionID, in.CWD)

	// Log suggestion signal-to-noise ratio.
	logSNR()

	// Clean up live session data from alfred.db.
	if st, err := store.OpenDefaultCached(); err == nil {
		_ = st.CleanupLiveSession(in.SessionID)
	}

	// Destroy ephemeral session DB.
	if sdb, err := sessiondb.Open(in.SessionID); err == nil {
		_ = sdb.Destroy()
	}
	return nil, nil
}

// logSNR is a placeholder — SNR/pattern tables were removed in alfred v1.
func logSNR() {}

// persistSessionData runs all persist functions for the given session.
// Safe to call multiple times — all writers are idempotent
// (Welford, EWMA upsert, ON CONFLICT aggregation).
// Does not destroy the session DB; caller decides lifecycle.
func persistSessionData(sessionID, cwd string) {
	if sessionID == "" {
		return
	}
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		return
	}
	defer sdb.Close()

	persistWorkflowSequence(sdb, sessionID)
	persistSessionMetrics(sdb)
	persistUserProfile(sdb)
	syncToGlobalDB(sdb, cwd)
	persistSessionMemory(sessionID, cwd)
}

// persistWorkflowSequence reads the phase sequence from alfred.db's live tables
// (populated by PostToolUse) and saves it as a workflow_sequence for future learning.
// Falls back to sessiondb phases if live data is unavailable.
func persistWorkflowSequence(sdb *sessiondb.SessionDB, sessionID string) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Read phases from alfred.db (populated directly by PostToolUse).
	phases, err := st.LivePhaseSequence(sessionID)
	if err != nil || len(phases) < 2 {
		// Fall back to sessiondb for orphan recovery or legacy sessions.
		phases, err = sdb.GetPhaseSequence()
		if err != nil || len(phases) < 2 {
			return
		}
	}

	taskTypeStr, _ := sdb.GetContext("task_type")
	if taskTypeStr == "" {
		return
	}

	// Heuristic success: no recent unresolved failures.
	success := true
	failures, _ := sdb.RecentFailures(3)
	for _, f := range failures {
		if f.FilePath == "" {
			continue
		}
		unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if unresolved {
			success = false
			break
		}
	}

	_ = st.InsertWorkflowSequence(sessionID, taskTypeStr, phases, success, len(phases), 0)
}

// persistSessionMetrics extracts per-session metrics and feeds them into
// the adaptive baselines (Welford online algorithm) in the persistent store.
func persistSessionMetrics(sdb *sessiondb.SessionDB) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Retry loop: max consecutive same-tool runs.
	events, err := sdb.RecentEvents(50)
	if err == nil && len(events) > 0 {
		maxConsecutive := 1
		consecutive := 1
		for i := 1; i < len(events); i++ {
			if events[i].ToolName == events[i-1].ToolName && events[i].InputHash == events[i-1].InputHash {
				consecutive++
				if consecutive > maxConsecutive {
					maxConsecutive = consecutive
				}
			} else {
				consecutive = 1
			}
		}
		_ = st.UpdateBaseline("retry_loop_consecutive", float64(maxConsecutive))

		// File hotspot: max writes to single file.
		fileWrites := make(map[uint64]int)
		maxWrites := 0
		for _, ev := range events {
			if ev.IsWrite {
				fileWrites[ev.InputHash]++
				if fileWrites[ev.InputHash] > maxWrites {
					maxWrites = fileWrites[ev.InputHash]
				}
			}
		}
		_ = st.UpdateBaseline("file_hotspot_writes", float64(maxWrites))

		// Distinct files modified.
		distinctFiles := make(map[uint64]bool)
		for _, ev := range events {
			if ev.IsWrite {
				distinctFiles[ev.InputHash] = true
			}
		}
		_ = st.UpdateBaseline("plan_mode_files", float64(len(distinctFiles)))
	}

	// No-progress metrics: tools in burst + elapsed minutes since burst start.
	tc, _, _, _ := sdb.BurstState()
	_ = st.UpdateBaseline("no_progress_tools", float64(tc))

	if startTime, err := sdb.BurstStartTime(); err == nil && !startTime.IsZero() {
		elapsed := time.Since(startTime).Minutes()
		_ = st.UpdateBaseline("no_progress_minutes", elapsed)
	}

	// Compaction burst: record burst tool count at session end as proxy for
	// typical burst size when compaction risk is evaluated.
	compacts, _ := sdb.CompactsInWindow(60)
	if compacts > 0 {
		_ = st.UpdateBaseline("compaction_burst_tools", float64(tc))
	}

	// EWMA error rate.
	errRate := getFloat(sdb, "ewma_error_rate")
	_ = st.UpdateBaseline("debug_error_rate", errRate)

	// Phase distribution metrics.
	phases, err := sdb.GetRawPhaseSequence(20)
	if err == nil && len(phases) > 0 {
		dist := phaseDist(phases)
		_ = st.UpdateBaseline("explore_read_pct", dist["read"])

		editBashCount := countPhaseTransitions(phases, "write", "compile") +
			countPhaseTransitions(phases, "write", "test")
		_ = st.UpdateBaseline("debug_edit_cycles", float64(editBashCount))
	}
}

// persistUserProfile extracts session-level coding style metrics
// and updates the persistent user profile with EWMA smoothing.
func persistUserProfile(sdb *sessiondb.SessionDB) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	tc, hasWrite, _, _ := sdb.BurstState()
	if tc == 0 {
		return
	}

	// tools_per_burst: total tools in this session burst.
	_ = st.UpdateUserProfile("tools_per_burst", float64(tc))

	// read_write_ratio: proportion of read vs write tools.
	events, err := sdb.RecentEvents(50)
	if err == nil && len(events) > 0 {
		reads, writes := 0, 0
		for _, ev := range events {
			if ev.IsWrite {
				writes++
			} else {
				reads++
			}
		}
		if writes > 0 {
			_ = st.UpdateUserProfile("read_write_ratio", float64(reads)/float64(writes))
		}
	}

	// test_frequency: did the user run tests? (1.0 = yes, 0.0 = no)
	hasTestRun, _ := sdb.GetContext("has_test_run")
	if hasTestRun == "true" {
		_ = st.UpdateUserProfile("test_frequency", 1.0)
	} else if hasWrite {
		_ = st.UpdateUserProfile("test_frequency", 0.0)
	}

	// compact_frequency: number of compactions in this session.
	compacts, _ := sdb.CompactsInWindow(525600) // 1 year — effectively all time in session
	_ = st.UpdateUserProfile("compact_frequency", float64(compacts))

	// avg_session_duration: session length in minutes.
	if startTime, err := sdb.BurstStartTime(); err == nil && !startTime.IsZero() {
		duration := time.Since(startTime).Minutes()
		_ = st.UpdateUserProfile("avg_session_duration", duration)
	}

	// reads_before_write: average number of read tools before the first write.
	if err == nil && len(events) > 0 {
		readsBeforeFirstWrite := 0
		foundWrite := false
		// Events are newest-first; iterate in reverse for chronological order.
		for i := len(events) - 1; i >= 0; i-- {
			if events[i].IsWrite {
				foundWrite = true
				break
			}
			readsBeforeFirstWrite++
		}
		if foundWrite {
			_ = st.UpdateUserProfile("reads_before_write", float64(readsBeforeFirstWrite))
		}
	}

	// test_before_edit: did user run tests before editing? (1.0=yes, 0.0=no)
	if err == nil && len(events) > 0 {
		sawTest := false
		sawWrite := false
		for i := len(events) - 1; i >= 0; i-- {
			name := events[i].ToolName
			if name == "Bash" && !events[i].IsWrite {
				// Approximate: Bash non-write is often a test run.
				sawTest = true
			}
			if events[i].IsWrite && !sawWrite {
				sawWrite = true
				if sawTest {
					_ = st.UpdateUserProfile("test_before_edit", 1.0)
				} else {
					_ = st.UpdateUserProfile("test_before_edit", 0.0)
				}
			}
		}
	}

	// suggestion_follow_rate: feedbacks table removed in alfred v1.
}

// syncToGlobalDB syncs patterns and decisions from the project store
// to the global cross-project database, and updates the project fingerprint.
func syncToGlobalDB(sdb *sessiondb.SessionDB, cwd string) {
	if cwd == "" {
		cwd, _ = sdb.GetContext("cwd")
	}
	if cwd == "" {
		return
	}

	gs, err := store.OpenGlobal()
	if err != nil {
		return
	}
	defer gs.Close()

	// Update project fingerprint.
	fp := store.GenerateFingerprint(cwd)
	_ = gs.UpsertFingerprint(fp)

	// Sync recent decisions from the project store.
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	decisions, err := st.GetDecisions("", fp.ProjectName, 5)
	if err != nil || len(decisions) == 0 {
		return
	}

	for _, d := range decisions {
		title := d.Topic
		if title == "" {
			title = d.DecisionText
			if len([]rune(title)) > 80 {
				title = string([]rune(title)[:80])
			}
		}
		_ = gs.InsertPattern(fp.ProjectName, "decision", title, d.DecisionText, fp.Languages)
	}
}


// RecoverOrphanedSessions scans /tmp/claude-alfred/ for session DBs
// that were not properly destroyed (SessionEnd never fired).
// Extracts and persists their data, then destroys them.
// Skips the current session. Returns the number of recovered sessions.
func RecoverOrphanedSessions(currentSessionID, cwd string) int {
	dir := filepath.Join(os.TempDir(), "claude-alfred")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}

	recovered := 0
	const maxRecover = 5

	for _, e := range entries {
		if recovered >= maxRecover {
			break
		}
		name := e.Name()
		if !strings.HasPrefix(name, "session-") || !strings.HasSuffix(name, ".db") {
			continue
		}
		// Skip WAL and SHM files.
		if strings.HasSuffix(name, "-wal") || strings.HasSuffix(name, "-shm") {
			continue
		}

		sessionID := strings.TrimPrefix(strings.TrimSuffix(name, ".db"), "session-")
		if sessionID == currentSessionID {
			continue
		}

		// Persist whatever knowledge the orphaned session accumulated.
		persistSessionData(sessionID, cwd)

		// Clean up live data and destroy the session DB.
		if st, serr := store.OpenDefaultCached(); serr == nil {
			_ = st.CleanupLiveSession(sessionID)
		}
		if sdb, serr := sessiondb.Open(sessionID); serr == nil {
			_ = sdb.Destroy()
			recovered++
		}
	}

	return recovered
}
