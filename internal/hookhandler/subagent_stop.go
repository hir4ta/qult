package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type subagentStopInput struct {
	CommonInput
	AgentName            string `json:"agent_name"`
	AgentType            string `json:"agent_type"`
	LastAssistantMessage string `json:"last_assistant_message,omitempty"`
}

var placeholderPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bTODO\b`),
	regexp.MustCompile(`(?i)\bFIXME\b`),
	regexp.MustCompile(`(?i)\bplaceholder\b`),
	regexp.MustCompile(`(?i)\bnot yet implemented\b`),
	regexp.MustCompile(`(?i)\b未実装\b`),
}

// handleSubagentStop checks subagent output for TODO/FIXME/placeholder markers.
// Provides quality gate feedback if incomplete work is detected.
func handleSubagentStop(input []byte) (*HookOutput, error) {
	var in subagentStopInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	if in.LastAssistantMessage == "" {
		return nil, nil
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] SubagentStop: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	var issues []string
	lower := strings.ToLower(in.LastAssistantMessage)
	for _, p := range placeholderPatterns {
		if p.MatchString(lower) {
			issues = append(issues, p.String())
		}
	}

	if len(issues) == 0 {
		return nil, nil
	}

	msg := fmt.Sprintf("[buddy] Subagent %q output contains incomplete markers (%s). Review before proceeding.",
		in.AgentName, strings.Join(issues, ", "))
	Deliver(sdb, "subagent-quality", "warning",
		"Subagent output quality check", msg, PriorityHigh)

	return makeAsyncContextOutput(msg), nil
}
