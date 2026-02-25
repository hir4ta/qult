package hookhandler

import (
	"encoding/json"
	"fmt"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
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

	// Clean up session DB.
	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		return nil, nil
	}
	_ = sdb.Destroy()

	return nil, nil
}
