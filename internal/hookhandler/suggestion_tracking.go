package hookhandler

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// recordNudgeDelivery records delivered nudges in the persistent store for effectiveness tracking.
// It saves the last outcome ID in session context for resolution detection.
func recordNudgeDelivery(sdb *sessiondb.SessionDB, sessionID string, nudges []sessiondb.Nudge) {
	if len(nudges) == 0 {
		return
	}

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	var lastID int64
	var lastPattern string
	for _, n := range nudges {
		id, err := st.InsertSuggestionOutcome(sessionID, n.Pattern, n.Suggestion)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[buddy] record nudge delivery: %v\n", err)
			continue
		}
		lastID = id
		lastPattern = n.Pattern
	}

	if lastID > 0 {
		_ = sdb.SetContext("last_nudge_outcome_id", strconv.FormatInt(lastID, 10))
		_ = sdb.SetContext("last_nudge_pattern", lastPattern)
	}
}

// checkNudgeResolution checks if the current tool action resolves a previously delivered nudge.
// Resolution heuristics by pattern:
//   - code-quality: next Edit/Write on any file → resolved
//   - retry-loop: tool name differs from last repeated tool → resolved
//   - workflow: test command executed → resolved
//   - stale-read: Read tool used → resolved
//   - test-correlation: test re-run → resolved
func checkNudgeResolution(sdb *sessiondb.SessionDB, toolName string) {
	pattern, _ := sdb.GetContext("last_nudge_pattern")
	if pattern == "" {
		return
	}
	outcomeIDStr, _ := sdb.GetContext("last_nudge_outcome_id")
	if outcomeIDStr == "" {
		return
	}

	resolved := false
	switch pattern {
	case "code-quality":
		resolved = toolName == "Edit" || toolName == "Write"
	case "retry-loop":
		resolved = toolName != "Bash"
	case "workflow":
		if toolName == "Bash" {
			resolved = true // approximate: any Bash after workflow nudge
		}
	case "stale-read":
		resolved = toolName == "Read"
	case "test-correlation":
		resolved = toolName == "Edit" || toolName == "Write"
	case "file-knowledge", "past-solution":
		// Informational nudges — resolved if any action follows.
		resolved = true
	default:
		// LLM fix suggestions (llm-fix:*) — resolved if Edit/Write succeeds after.
		if strings.HasPrefix(pattern, "llm-fix:") {
			resolved = toolName == "Edit" || toolName == "Write"
		}
	}

	if !resolved {
		return
	}

	// Clear context to avoid double-resolution.
	_ = sdb.SetContext("last_nudge_pattern", "")
	_ = sdb.SetContext("last_nudge_outcome_id", "")

	// Update user preference with resolution signal.
	// Estimate tools since delivery from burst state.
	tc, _, _, _ := sdb.BurstState()
	updatePreferenceOnResolution(pattern, tc)

	outcomeID, err := strconv.ParseInt(outcomeIDStr, 10, 64)
	if err != nil {
		return
	}

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	_ = st.ResolveSuggestion(outcomeID)
}

// checkLLMSuggestionResolution checks if a successful Edit/Write resolves a prior LLM fix suggestion.
func checkLLMSuggestionResolution(sdb *sessiondb.SessionDB, toolName string) {
	if toolName != "Edit" && toolName != "Write" {
		return
	}

	idStr, _ := sdb.GetContext("last_llm_outcome_id")
	if idStr == "" {
		return
	}

	// Clear to avoid double-resolution.
	_ = sdb.SetContext("last_llm_outcome_id", "")

	outcomeID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		return
	}

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	_ = st.ResolveSuggestion(outcomeID)
}

// updatePreferenceOnResolution updates the user_preferences table when a nudge is resolved.
func updatePreferenceOnResolution(pattern string, toolsSinceDelivery int) {
	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	// Compute response time proxy from tool count (approximate seconds).
	responseTimeSec := float64(toolsSinceDelivery) * 3.0
	_ = st.UpsertUserPreference(pattern, true, responseTimeSec)
}
