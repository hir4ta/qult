package hookhandler

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
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

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		return nil, nil
	}

	// Persist workflow sequence, session metrics, and tool sequences before destroying session DB.
	persistWorkflowSequence(sdb, in.SessionID)
	persistSessionMetrics(sdb)
	mergeToolSequencesToStore(sdb)

	_ = sdb.Destroy()
	return nil, nil
}

// persistWorkflowSequence extracts the phase sequence from session_phases
// and saves it to the persistent store for future workflow learning.
func persistWorkflowSequence(sdb *sessiondb.SessionDB, sessionID string) {
	phases, err := sdb.GetPhaseSequence()
	if err != nil || len(phases) < 2 {
		return // not enough data to learn from
	}

	taskTypeStr, _ := sdb.GetContext("task_type")
	if taskTypeStr == "" {
		return
	}

	phaseCount, _ := sdb.PhaseCount()

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

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

	_ = st.InsertWorkflowSequence(sessionID, taskTypeStr, phases, success, phaseCount, 0)
}

// persistSessionMetrics extracts per-session metrics and feeds them into
// the adaptive baselines (Welford online algorithm) in the persistent store.
func persistSessionMetrics(sdb *sessiondb.SessionDB) {
	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

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

		editBashCount := countTransitions(phases, "write", "compile") +
			countTransitions(phases, "write", "test")
		_ = st.UpdateBaseline("debug_edit_cycles", float64(editBashCount))
	}
}

// mergeToolSequencesToStore merges session-local tool bigrams and trigrams
// into the global persistent store for cross-session prediction.
func mergeToolSequencesToStore(sdb *sessiondb.SessionDB) {
	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	bigrams, err := sdb.AllToolSequences()
	if err == nil && len(bigrams) > 0 {
		_ = st.MergeToolSequences(bigrams)
	}

	trigrams, err := sdb.AllToolTrigrams()
	if err == nil && len(trigrams) > 0 {
		_ = st.MergeToolTrigrams(trigrams)
	}
}
