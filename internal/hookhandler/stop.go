package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

type stopInput struct {
	CommonInput
	LastAssistantMessage string `json:"last_assistant_message,omitempty"`
	StopHookActive       bool   `json:"stop_hook_active,omitempty"`
}

// Patterns indicating incomplete work in Claude's final message.
var incompletePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bnext step\b`),
	regexp.MustCompile(`(?i)\bremaining\b`),
	regexp.MustCompile(`(?i)\bnot yet\b`),
	regexp.MustCompile(`(?i)\bincomplete\b`),
	regexp.MustCompile(`後で`),
	regexp.MustCompile(`残り`),
	regexp.MustCompile(`未完了`),
}

// Patterns indicating unresolved errors in Claude's final message.
var stopErrorPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\btest.*fail`),
	regexp.MustCompile(`(?i)\bfailing test`),
	regexp.MustCompile(`(?i)\bbuild.*fail`),
	regexp.MustCompile(`(?i)\bcompilation.*fail`),
}

// handleStop analyzes Claude's final message for incomplete work and unresolved errors.
// Blocks Claude from stopping when there is high-confidence evidence of incomplete tasks
// (multiple text signals or sessiondb-confirmed failures).
// Single text signals produce a soft warning without blocking.
func handleStop(input []byte) (*HookOutput, error) {
	var in stopInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// If this is a re-attempt after a previous block, allow stop to prevent infinite loops.
	// This uses the official stop_hook_active field from Claude Code.
	if in.StopHookActive {
		return nil, nil
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[alfred] Stop: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	if in.LastAssistantMessage == "" {
		return nil, nil
	}

	var issues []string
	msg := in.LastAssistantMessage

	// Check for TODO/FIXME (reuse existing patterns from subagent_stop.go).
	for _, p := range placeholderPatterns {
		if p.MatchString(msg) {
			issues = append(issues, "incomplete marker (TODO/FIXME)")
			break
		}
	}

	// Check for incomplete task indicators.
	for _, p := range incompletePatterns {
		if p.MatchString(msg) {
			issues = append(issues, "incomplete task indicator")
			break
		}
	}

	// Check tail of message for unresolved error mentions.
	tail := msg
	if runeLen := len([]rune(tail)); runeLen > 500 {
		tail = string([]rune(tail)[runeLen-500:])
	}
	for _, p := range stopErrorPatterns {
		if p.MatchString(tail) {
			issues = append(issues, "unresolved error mentioned")
			break
		}
	}

	// Check sessiondb for unresolved failures.
	unresolvedCount := countUnresolvedFailures(sdb)
	if unresolvedCount > 0 {
		issues = append(issues, fmt.Sprintf("%d unresolved failure(s) in session", unresolvedCount))
	}

	if len(issues) == 0 {
		return nil, nil
	}

	// Block only with high confidence: sessiondb-confirmed failures OR multiple text signals.
	shouldBlock := unresolvedCount > 0 || len(issues) >= 2
	if shouldBlock {
		// Early persist: save session knowledge before block (data protection).
		cwd, _ := sdb.GetContext("cwd")
		persistSessionData(in.SessionID, cwd)

		reason := fmt.Sprintf("[alfred] Incomplete work detected: %s",
			strings.Join(issues, "; "))
		systemMsg := buildStopSystemMessage(sdb, issues)
		return &HookOutput{
			Decision:      "block",
			Reason:        reason,
			SystemMessage: systemMsg,
		}, nil
	}

	// Soft warning: SystemMessage for Claude (nudge_outbox is not read after Stop).
	systemMsg := fmt.Sprintf("[alfred] Heads up: %s. Consider resolving before completing.",
		strings.Join(issues, "; "))
	return &HookOutput{
		SystemMessage: systemMsg,
	}, nil
}

// buildStopSystemMessage builds a concrete, numbered action list for Claude.
// Uses sessiondb failures for high-fidelity items, text signals for lighter items.
func buildStopSystemMessage(sdb *sessiondb.SessionDB, issues []string) string {
	var actions []string

	// 1. Unresolved failures → concrete action (filename + error).
	failures, _ := sdb.RecentFailures(5)
	seen := make(map[string]bool)
	for _, f := range failures {
		if f.FilePath == "" || seen[f.FilePath] {
			continue
		}
		unresolved, failType, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if !unresolved {
			continue
		}
		seen[f.FilePath] = true
		actions = append(actions, actionForFailure(failType, f.FilePath, f.ErrorSig))
	}

	// 2. Text signals → lighter actions.
	for _, issue := range issues {
		switch {
		case strings.Contains(issue, "incomplete marker"):
			actions = append(actions, "Review and resolve TODO/FIXME markers in your changes")
		case strings.Contains(issue, "incomplete task"):
			actions = append(actions, "Complete the remaining tasks mentioned in your message")
		case strings.Contains(issue, "unresolved error"):
			actions = append(actions, "Verify that all mentioned test/build failures are resolved")
		}
	}

	if len(actions) == 0 {
		return ""
	}

	var b strings.Builder
	b.WriteString("[alfred] Before completing, please resolve these issues:\n")
	for i, a := range actions {
		fmt.Fprintf(&b, "%d. %s\n", i+1, a)
	}
	return b.String()
}

// actionForFailure returns a human-readable action for a specific failure type.
func actionForFailure(failType, filePath, errorSig string) string {
	short := filepath.Base(filePath)
	sig := truncate(errorSig, 60)
	switch failType {
	case "test_failure":
		return fmt.Sprintf("Run tests to verify %s (last failure: %s)", short, sig)
	case "compile_error":
		return fmt.Sprintf("Fix compile error in %s: %s", short, sig)
	case "edit_mismatch":
		return fmt.Sprintf("Re-read %s before editing (content mismatch detected)", short)
	default:
		if sig == "" {
			return fmt.Sprintf("Resolve failure in %s", short)
		}
		return fmt.Sprintf("Resolve failure in %s: %s", short, sig)
	}
}

// countUnresolvedFailures returns the number of unresolved failures in the session.
// Returns 0 for non-implementation task types (explore, review) since they don't
// produce code changes that need fixing.
func countUnresolvedFailures(sdb *sessiondb.SessionDB) int {
	if taskType, _ := sdb.GetContext("task_type"); taskType != "" {
		switch taskType {
		case "explore", "review", "question":
			return 0
		}
	}

	failures, _ := sdb.RecentFailures(5)
	count := 0
	for _, f := range failures {
		if f.FilePath == "" {
			continue
		}
		unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if unresolved {
			count++
		}
	}
	return count
}
