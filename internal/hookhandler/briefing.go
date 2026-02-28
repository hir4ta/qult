package hookhandler

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/coach"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// recentSignalEntry tracks a delivered signal for deduplication.
type recentSignalEntry struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

const maxRecentSignals = 3

// recordSignal saves a signal to the recent history (max 3 entries).
func recordSignal(sdb *sessiondb.SessionDB, sig *Signal) {
	if sig == nil {
		return
	}
	var history []recentSignalEntry
	if raw, _ := sdb.GetContext("recent_signals"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &history)
	}
	// Truncate detail for storage (first 120 chars).
	detail := sig.Detail
	if len(detail) > 120 {
		detail = detail[:120]
	}
	history = append(history, recentSignalEntry{Kind: sig.Kind, Detail: detail})
	if len(history) > maxRecentSignals {
		history = history[len(history)-maxRecentSignals:]
	}
	data, _ := json.Marshal(history)
	_ = sdb.SetContext("recent_signals", string(data))
}

// recentSignals returns the last N delivered signal entries.
func recentSignals(sdb *sessiondb.SessionDB) []recentSignalEntry {
	raw, _ := sdb.GetContext("recent_signals")
	if raw == "" {
		return nil
	}
	var history []recentSignalEntry
	_ = json.Unmarshal([]byte(raw), &history)
	return history
}

// isDuplicateSignal checks if a signal's kind+detail is too similar to recent history.
func isDuplicateSignal(sdb *sessiondb.SessionDB, sig *Signal) bool {
	if sig == nil {
		return false
	}
	for _, h := range recentSignals(sdb) {
		if h.Kind == sig.Kind && h.Detail != "" {
			// Same kind within recent window — check detail overlap.
			sigPrefix := sig.Detail
			if len(sigPrefix) > 60 {
				sigPrefix = sigPrefix[:60]
			}
			if sigPrefix != "" && (strings.Contains(sig.Detail, h.Detail) || strings.Contains(h.Detail, sigPrefix)) {
				return true
			}
		}
	}
	return false
}

// Signal represents a single JARVIS briefing signal to inject into Claude's context.
type Signal struct {
	Priority int    // 0 = highest (critical alert), 6 = lowest (health decline)
	Kind     string // "alert", "solution", "knowledge", "cochange", "phase", "strategic", "health"
	Detail   string // human-readable message for Claude
}

// selectTopSignal evaluates the current session state and returns the single
// most important signal for Claude, or nil when everything is healthy.
//
// Priority ladder:
//
//	P0 critical alert > P1 past solution > P2 knowledge match > P3 co-change >
//	P4 phase transition > P5 strategic insight > P6 health decline
func selectTopSignal(sdb *sessiondb.SessionDB, prompt, projectPath string) *Signal {
	// Candidate generators in priority order.
	candidates := []func() *Signal{
		// P0: Critical detection (action-level alert from HookDetector).
		func() *Signal {
			det, _ := sdb.LatestDetection("action")
			if det == nil || time.Since(det.Timestamp) >= 5*time.Minute {
				return nil
			}
			on, _ := sdb.IsOnCooldown("briefing_alert")
			if on {
				return nil
			}
			_ = sdb.SetCooldown("briefing_alert", 3*time.Minute)
			return &Signal{Priority: 0, Kind: "alert", Detail: det.Detail}
		},
		// P1: Past solution for a recent failure.
		func() *Signal { return findPastSolution(sdb) },
		// P2: Knowledge match (semantic search of past patterns).
		func() *Signal { return findKnowledgeSignal(sdb, prompt) },
		// P3: Co-change hint for the most recently edited file.
		func() *Signal { return findCoChangeHint(sdb) },
		// P4: Phase transition suggestion.
		func() *Signal { return findPhaseSignal(sdb) },
		// P5: Strategic insight (cross-session behavioral data).
		func() *Signal { return findStrategicSignal(sdb, projectPath) },
		// P6: Health decline trend.
		func() *Signal { return findHealthSignal(sdb) },
	}

	for _, gen := range candidates {
		sig := gen()
		if sig == nil {
			continue
		}
		// P0 (critical) always passes; others check dedup.
		if sig.Priority > 0 && isDuplicateSignal(sdb, sig) {
			continue
		}
		// Record for future dedup and return.
		recordSignal(sdb, sig)
		return sig
	}

	// Silent: everything is healthy.
	return nil
}

// findPastSolution checks for unresolved failures and looks up past solutions.
func findPastSolution(sdb *sessiondb.SessionDB) *Signal {
	on, _ := sdb.IsOnCooldown("briefing_solution")
	if on {
		return nil
	}

	failures, _ := sdb.RecentFailures(3)
	if len(failures) == 0 {
		return nil
	}

	// Only consider recent failures.
	var recentFail *sessiondb.FailureEntry
	for i := range failures {
		if time.Since(failures[i].Timestamp) < 5*time.Minute {
			recentFail = &failures[i]
			break
		}
	}
	if recentFail == nil {
		return nil
	}

	st, err := store.OpenDefault()
	if err != nil {
		return nil
	}
	defer st.Close()

	solutions, _ := st.SearchFailureSolutions(recentFail.FailureType, recentFail.ErrorSig, 1)
	if len(solutions) == 0 {
		return nil
	}

	_ = sdb.SetCooldown("briefing_solution", 5*time.Minute)

	detail := fmt.Sprintf("Past solution for %q: %s", recentFail.ErrorSig, solutions[0].SolutionText)
	if solutions[0].ResolutionDiff != "" {
		detail += fmt.Sprintf(" (diff: %s)", solutions[0].ResolutionDiff)
	}
	// Enrich with personal context.
	ps := personalContext(sdb)
	if ps != nil && ps.SessionCount >= 3 && ps.SuccessMedianTools > 0 {
		detail += fmt.Sprintf(" (Your avg resolution: %d tools)", ps.SuccessMedianTools)
	}
	return &Signal{Priority: 1, Kind: "solution", Detail: detail}
}

// findCoChangeHint checks if the most recently edited file has co-change partners.
func findCoChangeHint(sdb *sessiondb.SessionDB) *Signal {
	on, _ := sdb.IsOnCooldown("briefing_cochange")
	if on {
		return nil
	}

	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 {
		return nil
	}

	st, err := store.OpenDefault()
	if err != nil {
		return nil
	}
	defer st.Close()

	wsSet := make(map[string]bool, len(files))
	for _, f := range files {
		wsSet[f] = true
	}

	var missing []string
	seen := make(map[string]bool)
	for _, f := range files {
		coFiles, err := st.CoChangedFiles(f, 2)
		if err != nil {
			continue
		}
		for _, co := range coFiles {
			peer := co.FileA
			if peer == f {
				peer = co.FileB
			}
			if !wsSet[peer] && !seen[peer] {
				seen[peer] = true
				missing = append(missing, filepath.Base(peer))
			}
		}
		if len(missing) >= 3 {
			break
		}
	}

	if len(missing) == 0 {
		return nil
	}

	_ = sdb.SetCooldown("briefing_cochange", 10*time.Minute)
	detail := "Files often changed together (structural coupling, not accidental): also check " + strings.Join(missing, ", ")
	return &Signal{
		Priority: 3,
		Kind:     "cochange",
		Detail:   detail,
	}
}

// findPhaseSignal detects workflow phase transitions worth mentioning.
func findPhaseSignal(sdb *sessiondb.SessionDB) *Signal {
	on, _ := sdb.IsOnCooldown("briefing_phase")
	if on {
		return nil
	}

	progress := GetPhaseProgress(sdb)
	if progress == nil {
		return nil
	}

	// Only signal when there's an expected next phase and we've been in current phase a while.
	if progress.ExpectedPhase == PhaseUnknown || progress.ExpectedPhase == progress.CurrentPhase {
		return nil
	}

	if progress.ProgressPct < 70 {
		return nil
	}

	_ = sdb.SetCooldown("briefing_phase", 10*time.Minute)
	return &Signal{
		Priority: 4,
		Kind:     "phase",
		Detail:   fmt.Sprintf("Current phase: %s (%d%%). Consider moving to %s.", progress.CurrentPhase, progress.ProgressPct, progress.ExpectedPhase),
	}
}

// findHealthSignal detects declining session health.
func findHealthSignal(sdb *sessiondb.SessionDB) *Signal {
	on, _ := sdb.IsOnCooldown("briefing_health")
	if on {
		return nil
	}

	errRate := getFloat(sdb, "ewma_error_rate")
	if errRate > 0.3 {
		_ = sdb.SetCooldown("briefing_health", 10*time.Minute)
		return &Signal{
			Priority: 6,
			Kind:     "health",
			Detail:   fmt.Sprintf("Error rate is high (%.0f%%). Consider reviewing recent failures with buddy_alerts.", errRate*100),
		}
	}

	vel := getFloat(sdb, "ewma_tool_velocity")
	if vel > 0 && vel < 2.0 {
		_ = sdb.SetCooldown("briefing_health", 10*time.Minute)
		return &Signal{
			Priority: 6,
			Kind:     "health",
			Detail:   "Velocity is low. Session may be stuck. Consider buddy_diagnose for root cause analysis.",
		}
	}

	return nil
}

// formatBriefing converts a Signal into a compact string for additionalContext injection.
// Returns "" for nil signals. When additional context is available, builds a narrative
// that weaves together the signal with session state.
func formatBriefing(sig *Signal) string {
	if sig == nil {
		return ""
	}
	return fmt.Sprintf("[buddy:briefing] %s", sig.Detail)
}

// buildNarrative enriches a signal with session context to produce a coherent narrative.
// Weaves together the signal, working set state, failure log, and phase info.
func buildNarrative(sig *Signal, sdb *sessiondb.SessionDB) string {
	if sig == nil {
		return ""
	}

	var parts []string
	parts = append(parts, sig.Detail)

	// Add failure context for solution/alert signals with causal chain.
	if sig.Kind == "solution" || sig.Kind == "alert" {
		failures, _ := sdb.RecentFailures(1)
		if len(failures) > 0 {
			f := failures[0]
			if f.FilePath != "" {
				count, _ := sdb.FileEditCount(f.FilePath)
				cause := fmt.Sprintf("Failure in %s", filepath.Base(f.FilePath))
				effect := "blocks progress"
				evidence := ""
				if count > 1 {
					evidence = fmt.Sprintf("%s edited %d times", filepath.Base(f.FilePath), count)
				}
				// Add personal context.
				ps := personalContext(sdb)
				if ps != nil && ps.SessionCount >= 3 && ps.SuccessMedianTools > 0 {
					if evidence != "" {
						evidence += ". "
					}
					evidence += fmt.Sprintf("Your successful sessions avg %d tools", ps.SuccessMedianTools)
				}
				action := "Apply the past fix or use buddy_diagnose for alternatives"
				parts = append(parts, formatCausalChain(cause, effect, evidence, action))
			}
		} else {
			parts = append(parts, "→ Apply the past fix or use buddy_diagnose for alternatives.")
		}
	}

	// Add test status context for phase transitions.
	if sig.Kind == "phase" {
		hasTestRun, _ := sdb.GetContext("has_test_run")
		if hasTestRun != "true" {
			tc, _, _, _ := sdb.BurstState()
			if tc > 15 {
				parts = append(parts, fmt.Sprintf("Tests not run yet (%d tools in session).", tc))
			}
		}

		// Incorporate AI coaching context if available.
		if cached := lookupCachedCoaching(sdb); cached != "" {
			parts = append(parts, cached)
		}
	}

	// Enrich knowledge signals with deep-dive hint.
	if sig.Kind == "knowledge" {
		parts = append(parts, "→ Dig deeper: call buddy_knowledge with a refined query to see full pattern details and related decisions.")
	}

	// Add co-change reminder for knowledge signals about specific files.
	if sig.Kind == "knowledge" || sig.Kind == "cochange" {
		files, _ := sdb.GetWorkingSetFiles()
		if len(files) > 0 && len(files) <= 3 {
			st, err := store.OpenDefault()
			if err == nil {
				defer st.Close()
				for _, f := range files {
					coFiles, _ := st.CoChangedFiles(f, 2)
					for _, co := range coFiles {
						peer := co.FileA
						if peer == f {
							peer = co.FileB
						}
						// Check peer not already in working set.
						inWS := false
						for _, wf := range files {
							if wf == peer {
								inWS = true
								break
							}
						}
						if !inWS {
							parts = append(parts, fmt.Sprintf("Also check %s (frequently changed together).", filepath.Base(peer)))
							break
						}
					}
					break // only check first file
				}
			}
		}
	}

	// Actionable hints for remaining signal types.
	if sig.Kind == "health" {
		parts = append(parts, "→ Dig deeper: call buddy_state(detail='outlook') for health trends and risk predictions.")
	}
	if sig.Kind == "strategic" {
		parts = append(parts, "→ Dig deeper: call buddy_plan(mode='strategy') for an optimal phase-sequenced plan.")
	}
	if sig.Kind == "solution" {
		parts = append(parts, "→ Dig deeper: call buddy_diagnose for root cause analysis and alternative fix patches.")
	}

	// Weave recent signal history into narrative for continuity.
	history := recentSignals(sdb)
	if len(history) >= 2 {
		// Build a brief continuity note from the previous signal.
		prev := history[len(history)-2] // second-to-last = previous turn's signal
		if prev.Kind != sig.Kind {
			// Cross-reference creates a narrative arc.
			parts = append(parts, fmt.Sprintf("(Previous signal: %s — %s.)", prev.Kind, truncate(prev.Detail, 60)))
		}
	}

	if len(parts) == 1 {
		return parts[0]
	}
	return strings.Join(parts, " ")
}

// lookupCachedCoaching returns a one-line AI coaching SITUATION from cache, or "".
func lookupCachedCoaching(sdb *sessiondb.SessionDB) string {
	cwd, _ := sdb.GetContext("cwd")
	taskType, _ := sdb.GetContext("task_type")
	domain, _ := sdb.GetWorkingSet("domain")
	if cwd == "" || taskType == "" {
		return ""
	}

	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

	cached, ok := st.GetCachedCoaching(cwd, taskType, domain, 24*time.Hour)
	if !ok || cached == "" {
		return ""
	}

	r := coach.ParseCoachingResult(cached)
	if r.Situation != "" {
		return "AI coaching: " + r.Situation
	}
	return ""
}
