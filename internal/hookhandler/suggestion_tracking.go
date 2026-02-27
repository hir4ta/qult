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
// It saves the last outcome ID in session context for resolution detection,
// and records the current tool count for timeout-based negative signal detection.
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

		// Record tool count at delivery for timeout detection.
		tc, _, _, _ := sdb.BurstState()
		_ = sdb.SetContext("nudge_delivered_tool_count", strconv.Itoa(tc))
	}
}

// checkNudgeTimeout detects when a nudge has been delivered but not resolved
// after 4+ tool calls. This implicit negative signal indicates the suggestion
// was likely not actionable or relevant.
func checkNudgeTimeout(sdb *sessiondb.SessionDB) {
	pattern, _ := sdb.GetContext("last_nudge_pattern")
	if pattern == "" {
		return
	}

	deliveredAtStr, _ := sdb.GetContext("nudge_delivered_tool_count")
	if deliveredAtStr == "" {
		return
	}
	deliveredAt, err := strconv.Atoi(deliveredAtStr)
	if err != nil {
		return
	}

	tc, _, _, _ := sdb.BurstState()
	if tc-deliveredAt < 4 {
		return
	}

	// 4+ tools elapsed without resolution — record negative signal.
	_ = sdb.SetContext("last_nudge_pattern", "")
	_ = sdb.SetContext("last_nudge_outcome_id", "")
	_ = sdb.SetContext("nudge_delivered_tool_count", "")

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	sessionID, _ := sdb.GetContext("session_id")
	if sessionID == "" {
		sessionID = "unknown"
	}

	_ = st.InsertFeedback(sessionID, pattern, store.RatingNotHelpful, "auto:timeout", 0)
	_ = st.UpsertUserPreference(pattern, false, 0)
}

// checkNudgeResolution checks if the current tool action resolves a previously delivered nudge.
// Instead of immediately resolving, it marks the resolution as "pending" so the next
// tool outcome (success/failure) can verify whether the resolution was genuine.
// This reduces false positives in auto-feedback.
//
// Resolution heuristics by pattern:
//   - code-quality: next Edit/Write on any file → pending
//   - retry-loop: tool name differs from last repeated tool → pending
//   - workflow: test command executed → pending
//   - stale-read: Read tool used → pending
//   - test-correlation: test re-run → pending
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

	// Mark as pending verification instead of immediate resolution.
	// The next PostToolUse (success) or PostToolFailure (failure) will verify.
	_ = sdb.SetContext("pending_resolution_pattern", pattern)
	_ = sdb.SetContext("pending_resolution_id", outcomeIDStr)

	// Clear the nudge context to avoid double-triggering.
	_ = sdb.SetContext("last_nudge_pattern", "")
	_ = sdb.SetContext("last_nudge_outcome_id", "")
}

// verifyPendingResolution confirms or rejects a pending nudge resolution based on
// the outcome of the tool that appeared to resolve it.
// Called from PostToolUse (isSuccess=true) and PostToolFailure (isSuccess=false).
func verifyPendingResolution(sdb *sessiondb.SessionDB, isSuccess bool) {
	pattern, _ := sdb.GetContext("pending_resolution_pattern")
	if pattern == "" {
		return
	}
	outcomeIDStr, _ := sdb.GetContext("pending_resolution_id")
	if outcomeIDStr == "" {
		return
	}

	// Clear pending state.
	_ = sdb.SetContext("pending_resolution_pattern", "")
	_ = sdb.SetContext("pending_resolution_id", "")

	outcomeID, err := strconv.ParseInt(outcomeIDStr, 10, 64)
	if err != nil {
		return
	}

	tc, _, _, _ := sdb.BurstState()

	if isSuccess {
		// Confirmed: the resolution action succeeded.
		updatePreferenceOnResolution(pattern, tc)
		recordAutoFeedback(sdb, pattern, tc)

		st, err := store.OpenDefault()
		if err != nil {
			return
		}
		defer st.Close()
		_ = st.ResolveSuggestion(outcomeID)
	} else {
		// False positive: the "resolution" action failed — the nudge didn't actually help.
		recordFalsePositiveFeedback(sdb, pattern)
	}
}

// recordFalsePositiveFeedback records a not_helpful auto-feedback when a pending
// resolution turns out to be a false positive (the follow-up action failed).
func recordFalsePositiveFeedback(sdb *sessiondb.SessionDB, pattern string) {
	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	sessionID, _ := sdb.GetContext("session_id")
	if sessionID == "" {
		sessionID = "unknown"
	}

	_ = st.InsertFeedback(sessionID, pattern, store.RatingNotHelpful, "auto:false_positive", 0)
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

// inferFeedbackRating estimates a feedback rating from the number of tools
// between delivery and resolution. Faster resolution implies higher quality.
func inferFeedbackRating(toolsSinceDelivery int) store.FeedbackRating {
	switch {
	case toolsSinceDelivery <= 1:
		return store.RatingHelpful
	case toolsSinceDelivery <= 3:
		return store.RatingPartiallyHelpful
	default:
		return store.RatingNotHelpful
	}
}

// recordAutoFeedback records an auto-inferred feedback entry when a nudge is resolved.
// Skips recording when explicit feedback contradicts the auto-inferred rating,
// deferring to the user's explicit judgement.
func recordAutoFeedback(sdb *sessiondb.SessionDB, pattern string, toolsSinceDelivery int) {
	rating := inferFeedbackRating(toolsSinceDelivery)

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	// Skip auto-feedback when it contradicts explicit user feedback.
	if st.CheckFeedbackContradiction(pattern) {
		return
	}

	sessionID, _ := sdb.GetContext("session_id")
	if sessionID == "" {
		sessionID = "unknown"
	}

	if err := st.InsertFeedback(sessionID, pattern, rating, "auto:resolved", 0); err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] record auto feedback: %v\n", err)
	}
}

// recordUnresolvedFeedback records a not_helpful feedback when a burst ends
// without resolving the pending nudge. Called from burst reset.
func recordUnresolvedFeedback(sdb *sessiondb.SessionDB) {
	pattern, _ := sdb.GetContext("last_nudge_pattern")
	if pattern == "" {
		return
	}

	// Clear the pending nudge to prevent double-recording.
	_ = sdb.SetContext("last_nudge_pattern", "")
	_ = sdb.SetContext("last_nudge_outcome_id", "")

	// Track unresolved pattern for enrichment on next encounter.
	_ = sdb.SetContext("last_unresolved_pattern", pattern)

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	sessionID, _ := sdb.GetContext("session_id")
	if sessionID == "" {
		sessionID = "unknown"
	}

	_ = st.InsertFeedback(sessionID, pattern, store.RatingNotHelpful, "", 0)
	_ = st.UpsertUserPreference(pattern, false, 0)
}
