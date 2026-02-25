package hookhandler

import (
	"encoding/json"
	"fmt"

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

	// Persist workflow sequence before destroying session DB.
	persistWorkflowSequence(sdb, in.SessionID)

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
