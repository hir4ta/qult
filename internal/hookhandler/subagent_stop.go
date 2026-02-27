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

var errorPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\berror\b.*\b(occurred|found|detected)\b`),
	regexp.MustCompile(`(?i)\bfailed\b`),
	regexp.MustCompile(`(?i)\bpanic\b`),
	regexp.MustCompile(`(?i)\bfatal\b`),
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

	SetDeliveryContext(sdb)

	var issues []string
	lower := strings.ToLower(in.LastAssistantMessage)
	for _, p := range placeholderPatterns {
		if p.MatchString(lower) {
			issues = append(issues, "incomplete marker")
			break
		}
	}

	// Check tail of message for error keywords.
	tail := lower
	if len([]rune(tail)) > 300 {
		tail = string([]rune(tail)[len([]rune(tail))-300:])
	}
	for _, p := range errorPatterns {
		if p.MatchString(tail) {
			issues = append(issues, "error detected")
			break
		}
	}

	// Code changes without test mention.
	hasCodeChange := strings.Contains(lower, "edit") || strings.Contains(lower, "write") || strings.Contains(lower, "created")
	hasTestMention := strings.Contains(lower, "test") || strings.Contains(lower, "verify") || strings.Contains(lower, "verified")
	if hasCodeChange && !hasTestMention {
		issues = append(issues, "code changed without test mention")
	}

	if len(issues) == 0 {
		return nil, nil
	}

	reason := fmt.Sprintf("[buddy] Subagent %q quality check failed: %s. Fix these issues before completing.",
		in.AgentName, strings.Join(issues, "; "))
	Deliver(sdb, "subagent-quality", "warning",
		"Subagent output quality check", reason, PriorityHigh,
		"Subagent output without test coverage risks propagating untested code into your codebase.")

	return makeBlockStopOutput(reason), nil
}
