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
// deliveryChannel indicates source ("hook" or "mcp"), predictedPriority is the TS-adjusted priority.
func recordNudgeDelivery(sdb *sessiondb.SessionDB, sessionID string, nudges []sessiondb.Nudge) {
	recordNudgeDeliveryWithMeta(sdb, sessionID, nudges, "hook", "")
}

func recordNudgeDeliveryWithMeta(sdb *sessiondb.SessionDB, sessionID string, nudges []sessiondb.Nudge, deliveryChannel, predictedPriority string) {
	if len(nudges) == 0 {
		return
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	var lastID int64
	var lastPattern string
	for _, n := range nudges {
		id, err := st.InsertSuggestionOutcome(sessionID, n.Pattern, n.Suggestion)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[buddy] record nudge delivery: %v\n", err)
			continue
		}
		// Record delivery metadata for accuracy measurement.
		if deliveryChannel != "" || predictedPriority != "" {
			_ = st.UpdateSuggestionMeta(id, deliveryChannel, predictedPriority)
		}
		// Estimate token cost for B8 cost tracking.
		cost := estimateTokenCost(n.Suggestion)
		if cost > 0 {
			_ = st.UpdateSuggestionContext(id, fmt.Sprintf(`{"estimated_tokens":%d}`, cost))
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

// estimateTokenCost approximates token count from character length.
// Uses a rough 4 chars/token ratio for English-heavy content.
func estimateTokenCost(text string) int {
	if len(text) == 0 {
		return 0
	}
	return (len(text) + 3) / 4
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
	outcomeIDStr, _ := sdb.GetContext("last_nudge_outcome_id")
	toolsAfter := tc - deliveredAt

	// Read detection confidence: low-confidence detections (likely false positives)
	// should not poison Thompson Sampling when they time out.
	confStr, _ := sdb.GetContext("last_detection_confidence")
	confidence := 1.0
	if confStr != "" {
		if c, cerr := strconv.ParseFloat(confStr, 64); cerr == nil {
			confidence = c
		}
	}

	_ = sdb.SetContext("last_nudge_pattern", "")
	_ = sdb.SetContext("last_nudge_outcome_id", "")
	_ = sdb.SetContext("nudge_delivered_tool_count", "")
	_ = sdb.SetContext("last_detection_confidence", "")

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Record tools_after for savings analysis.
	if outcomeIDStr != "" {
		if oid, perr := strconv.ParseInt(outcomeIDStr, 10, 64); perr == nil {
			_ = st.UpdateToolsAfter(oid, toolsAfter)
		}
	}

	// Skip negative feedback for low-confidence detections to prevent TS pollution.
	if confidence < 0.5 {
		return
	}

	sessionID, _ := sdb.GetContext("session_id")
	if sessionID == "" {
		sessionID = "unknown"
	}

	// Downgrade feedback for medium-confidence detections.
	if confidence < 0.7 {
		_ = st.InsertFeedback(sessionID, pattern, store.RatingPartiallyHelpful, "auto:timeout:mid_conf", 0)
		return
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

	// Compute tools elapsed since delivery for savings tracking.
	deliveredAtStr, _ := sdb.GetContext("nudge_delivered_tool_count")
	toolsAfter := tc
	if deliveredAtStr != "" {
		if dat, err := strconv.Atoi(deliveredAtStr); err == nil {
			toolsAfter = tc - dat
		}
	}

	if isSuccess {
		// Confirmed: the resolution action succeeded.
		updatePreferenceOnResolution(pattern, tc)
		recordAutoFeedback(sdb, pattern, tc)

		st, err := store.OpenDefaultCached()
		if err != nil {
			return
		}
		_ = st.ResolveSuggestion(outcomeID)
		_ = st.UpdateToolsAfter(outcomeID, toolsAfter)

		// Update per-user pattern effectiveness.
		cwd, _ := sdb.GetContext("cwd")
		taskType, _ := sdb.GetContext("task_type")
		if cwd != "" {
			_ = st.UpdateUserPatternEffectiveness(cwd, pattern, taskType, true)
		}

		// If a past-solution nudge was resolved, mark the solution as effective.
		if pattern == "past-solution" {
			if idStr, _ := sdb.GetContext("last_surfaced_solution_id"); idStr != "" {
				var solutionID int
				if _, serr := fmt.Sscanf(idStr, "%d", &solutionID); serr == nil && solutionID > 0 {
					_ = st.IncrementTimesEffective(solutionID)
				}
				_ = sdb.SetContext("last_surfaced_solution_id", "")
			}
		}
	} else {
		// False positive: the "resolution" action failed — the nudge didn't actually help.
		recordFalsePositiveFeedback(sdb, pattern)

		// Track unresolved in per-user effectiveness.
		st, err := store.OpenDefaultCached()
		if err == nil {
			cwd, _ := sdb.GetContext("cwd")
			taskType, _ := sdb.GetContext("task_type")
			if cwd != "" {
				_ = st.UpdateUserPatternEffectiveness(cwd, pattern, taskType, false)
			}
		}
	}
}

// recordFalsePositiveFeedback records a not_helpful auto-feedback when a pending
// resolution turns out to be a false positive (the follow-up action failed).
func recordFalsePositiveFeedback(sdb *sessiondb.SessionDB, pattern string) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

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

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	_ = st.ResolveSuggestion(outcomeID)
}

// updatePreferenceOnResolution updates the user_preferences table when a nudge is resolved.
func updatePreferenceOnResolution(pattern string, toolsSinceDelivery int) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Compute response time proxy from tool count (approximate seconds).
	responseTimeSec := float64(toolsSinceDelivery) * 3.0
	_ = st.UpsertUserPreference(pattern, true, responseTimeSec)
}

// inferFeedbackRating estimates a feedback rating from the number of tools
// between delivery and resolution. Thresholds are adapted per task type:
// feature/refactor tasks naturally take more tools, so the "helpful" window is wider.
func inferFeedbackRating(toolsSinceDelivery int) store.FeedbackRating {
	helpfulMax, partialMax := feedbackThresholds()
	switch {
	case toolsSinceDelivery <= helpfulMax:
		return store.RatingHelpful
	case toolsSinceDelivery <= partialMax:
		return store.RatingPartiallyHelpful
	default:
		return store.RatingNotHelpful
	}
}

// feedbackThresholds returns (helpfulMax, partialMax) tool counts for auto-feedback.
// Adapted by task type: bugfix resolves fast, feature/refactor take more steps.
func feedbackThresholds() (int, int) {
	switch TaskType(ctxTaskType) {
	case TaskBugfix, TaskDebug:
		return 2, 4
	case TaskFeature, TaskDocs:
		return 5, 8
	case TaskRefactor:
		return 4, 7
	case TaskTest:
		return 3, 5
	default:
		return 2, 4
	}
}

// recordAutoFeedback records an auto-inferred feedback entry when a nudge is resolved.
// Skips recording when explicit feedback contradicts the auto-inferred rating,
// deferring to the user's explicit judgement.
func recordAutoFeedback(sdb *sessiondb.SessionDB, pattern string, toolsSinceDelivery int) {
	rating := inferFeedbackRating(toolsSinceDelivery)

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

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

	outcomeIDStr, _ := sdb.GetContext("last_nudge_outcome_id")
	deliveredAtStr, _ := sdb.GetContext("nudge_delivered_tool_count")

	// Clear the pending nudge to prevent double-recording.
	_ = sdb.SetContext("last_nudge_pattern", "")
	_ = sdb.SetContext("last_nudge_outcome_id", "")
	_ = sdb.SetContext("nudge_delivered_tool_count", "")

	// Track unresolved pattern for enrichment on next encounter.
	_ = sdb.SetContext("last_unresolved_pattern", pattern)

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Record tools_after for savings analysis.
	if outcomeIDStr != "" && deliveredAtStr != "" {
		tc, _, _, _ := sdb.BurstState()
		if dat, derr := strconv.Atoi(deliveredAtStr); derr == nil {
			if oid, perr := strconv.ParseInt(outcomeIDStr, 10, 64); perr == nil {
				_ = st.UpdateToolsAfter(oid, tc-dat)
			}
		}
	}

	sessionID, _ := sdb.GetContext("session_id")
	if sessionID == "" {
		sessionID = "unknown"
	}

	_ = st.InsertFeedback(sessionID, pattern, store.RatingNotHelpful, "", 0)
	_ = st.UpsertUserPreference(pattern, false, 0)
}

// checkSignalResolution detects whether the current tool action resolves a
// previously delivered JARVIS briefing signal. Uses kind-specific heuristics.
func checkSignalResolution(sdb *sessiondb.SessionDB, toolName string) {
	idStr, _ := sdb.GetContext("last_signal_outcome_id")
	if idStr == "" {
		return
	}
	kind, _ := sdb.GetContext("last_signal_kind")

	resolved := false
	switch kind {
	case "critical_alert", "episode_alert":
		// Alert acted on if the user changes approach (Edit, Write, or different tool).
		resolved = toolName == "Edit" || toolName == "Write"
	case "past_solution", "knowledge_match":
		// Knowledge applied via Edit/Write.
		resolved = toolName == "Edit" || toolName == "Write"
	case "co_change":
		// Co-change hint acted on if the related file is read or edited.
		resolved = toolName == "Read" || toolName == "Edit" || toolName == "Write"
	case "phase_transition":
		// Phase transition acknowledged by any subsequent action.
		resolved = true
	case "strategic_insight":
		// Strategic insights are informational; any MCP call or test run counts.
		resolved = toolName == "Bash" || toolName == "Edit"
	case "health_decline":
		// Health concern addressed if user changes approach.
		resolved = toolName == "Edit" || toolName == "Write" || toolName == "Read"
	default:
		// Unknown kind — resolve on any write action.
		resolved = toolName == "Edit" || toolName == "Write"
	}

	if !resolved {
		return
	}

	outcomeID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		return
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}
	_ = st.ResolveSignalOutcome(outcomeID)

	// Feed Thompson Sampling: resolved signal = positive auto-feedback.
	tc, _, _, _ := sdb.BurstState()
	recordAutoFeedback(sdb, "briefing:"+kind, tc)

	// Clear to avoid double-resolution.
	_ = sdb.SetContext("last_signal_outcome_id", "")
	_ = sdb.SetContext("last_signal_kind", "")
}
