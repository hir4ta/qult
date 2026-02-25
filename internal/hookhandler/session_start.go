package hookhandler

import (
	"encoding/json"
	"fmt"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

type sessionStartInput struct {
	CommonInput
	Source    string `json:"source"`
	Model     string `json:"model"`
	AgentType string `json:"agent_type,omitempty"`
}

func handleSessionStart(input []byte) (*HookOutput, error) {
	var in sessionStartInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// Create/open session DB.
	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		return nil, fmt.Errorf("open session db: %w", err)
	}
	defer sdb.Close()

	switch in.Source {
	case "startup", "resume":
		return handleStartupResume(in)
	case "compact":
		// Record compact in session DB.
		_ = sdb.RecordCompact()
		return handlePostCompactResume(sdb)
	default:
		return nil, nil
	}
}

func handleStartupResume(in sessionStartInput) (*HookOutput, error) {
	st, err := store.OpenDefault()
	if err != nil {
		// No store available — skip resume.
		return nil, nil
	}
	defer st.Close()

	data, err := BuildResumeData(st, "", in.CWD)
	if err != nil || data == nil {
		return nil, nil
	}

	ctx := FormatResumeContext(data)
	if ctx == "" {
		return nil, nil
	}

	return makeOutput("SessionStart", ctx), nil
}

func handlePostCompactResume(sdb *sessiondb.SessionDB) (*HookOutput, error) {
	nudges, _ := sdb.DequeueNudges(2)
	if len(nudges) == 0 {
		return nil, nil
	}

	entries := make([]nudgeEntry, len(nudges))
	for i, n := range nudges {
		entries[i] = nudgeEntry{
			Pattern:     n.Pattern,
			Level:       n.Level,
			Observation: n.Observation,
			Suggestion:  n.Suggestion,
		}
	}
	return makeOutput("SessionStart", formatNudges(entries)), nil
}
