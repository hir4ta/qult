package hookhandler

import (
	"encoding/json"
	"fmt"
	"strings"
)

type stopInput struct {
	CommonInput
	StopHookActive       bool   `json:"stop_hook_active"`
	LastAssistantMessage string `json:"last_assistant_message"`
}

func handleStop(input []byte) (*HookOutput, error) {
	var in stopInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// Prevent infinite loops: if stop_hook_active, allow stop immediately.
	if in.StopHookActive {
		return nil, nil
	}

	issues := checkCompleteness(in.LastAssistantMessage)
	if len(issues) > 0 {
		return makeBlockStopOutput(strings.Join(issues, "; ")), nil
	}

	return nil, nil
}

// checkCompleteness scans assistant message for signs of incomplete work.
// Only checks for high-signal deterministic patterns. Error detection is
// left to the LLM prompt hook to avoid false positives on explanatory text.
func checkCompleteness(msg string) []string {
	if msg == "" {
		return nil
	}

	lower := strings.ToLower(msg)
	var issues []string

	// TODO/FIXME markers.
	for _, p := range []string{"todo:", "fixme:", "hack:", "xxx:"} {
		if strings.Contains(lower, p) {
			issues = append(issues, "TODO/FIXME marker found in last response")
			break
		}
	}

	// Explicit incomplete work.
	for _, p := range []string{
		"i'll finish", "i'll complete", "remaining work",
		"not yet implemented", "placeholder",
		"まだ完了していません", "残りの作業", "未実装",
	} {
		if strings.Contains(lower, p) {
			issues = append(issues, "Incomplete work mentioned in last response")
			break
		}
	}

	return issues
}
