package hookhandler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/coach"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
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

	// Persist session knowledge (workflow, metrics, user profile, global sync).
	persistSessionData(in.SessionID, in.CWD)

	// Log suggestion signal-to-noise ratio.
	logSNR()

	// Clean up live session data from buddy.db.
	if st, err := store.OpenDefaultCached(); err == nil {
		_ = st.CleanupLiveSession(in.SessionID)
	}

	// Destroy ephemeral session DB.
	if sdb, err := sessiondb.Open(in.SessionID); err == nil {
		_ = sdb.Destroy()
	}
	return nil, nil
}

// logSNR computes and logs the suggestion signal-to-noise ratio at session end.
// When SNR is below 0.5 with a meaningful sample size, identifies the
// lowest-performing patterns for diagnostic visibility.
func logSNR() {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	snr, total, err := st.ComputeSNR(30)
	if err != nil || total == 0 {
		return
	}

	fmt.Fprintf(os.Stderr, "[buddy] SNR: %.2f (%d suggestions in last 30 days)\n", snr, total)

	if snr < 0.5 && total > 20 {
		worst, err := st.LowestPerformingPatterns(30, 3, 5)
		if err != nil || len(worst) == 0 {
			return
		}
		fmt.Fprintf(os.Stderr, "[buddy] Low SNR — worst patterns:\n")
		for _, p := range worst {
			fmt.Fprintf(os.Stderr, "[buddy]   %s: %.0f%% resolved (%d/%d)\n",
				p.Pattern, p.Rate*100, p.Resolved, p.Total)
		}
	}
}

// persistSessionData runs all persist functions for the given session.
// Safe to call multiple times — all writers are idempotent
// (Welford, EWMA upsert, ON CONFLICT aggregation).
// Does not destroy the session DB; caller decides lifecycle.
func persistSessionData(sessionID, cwd string) {
	if sessionID == "" {
		return
	}
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		return
	}
	defer sdb.Close()

	persistWorkflowSequence(sdb, sessionID)
	persistSessionMetrics(sdb)
	persistUserProfile(sdb)
	syncToGlobalDB(sdb, cwd)
	extractPatternsWithLLM(sdb, sessionID)
	preGenerateCoaching(sdb, cwd)
	persistSessionMemory(sessionID, cwd)
}

// persistWorkflowSequence reads the phase sequence from buddy.db's live tables
// (populated by PostToolUse) and saves it as a workflow_sequence for future learning.
// Falls back to sessiondb phases if live data is unavailable.
func persistWorkflowSequence(sdb *sessiondb.SessionDB, sessionID string) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Read phases from buddy.db (populated directly by PostToolUse).
	phases, err := st.LivePhaseSequence(sessionID)
	if err != nil || len(phases) < 2 {
		// Fall back to sessiondb for orphan recovery or legacy sessions.
		phases, err = sdb.GetPhaseSequence()
		if err != nil || len(phases) < 2 {
			return
		}
	}

	taskTypeStr, _ := sdb.GetContext("task_type")
	if taskTypeStr == "" {
		return
	}

	// Heuristic success: no recent unresolved failures.
	success := true
	failures, _ := sdb.RecentFailures(3)
	for _, f := range failures {
		if f.FilePath == "" {
			continue
		}
		unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if unresolved {
			success = false
			break
		}
	}

	_ = st.InsertWorkflowSequence(sessionID, taskTypeStr, phases, success, len(phases), 0)
}

// persistSessionMetrics extracts per-session metrics and feeds them into
// the adaptive baselines (Welford online algorithm) in the persistent store.
func persistSessionMetrics(sdb *sessiondb.SessionDB) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Retry loop: max consecutive same-tool runs.
	events, err := sdb.RecentEvents(50)
	if err == nil && len(events) > 0 {
		maxConsecutive := 1
		consecutive := 1
		for i := 1; i < len(events); i++ {
			if events[i].ToolName == events[i-1].ToolName && events[i].InputHash == events[i-1].InputHash {
				consecutive++
				if consecutive > maxConsecutive {
					maxConsecutive = consecutive
				}
			} else {
				consecutive = 1
			}
		}
		_ = st.UpdateBaseline("retry_loop_consecutive", float64(maxConsecutive))

		// File hotspot: max writes to single file.
		fileWrites := make(map[uint64]int)
		maxWrites := 0
		for _, ev := range events {
			if ev.IsWrite {
				fileWrites[ev.InputHash]++
				if fileWrites[ev.InputHash] > maxWrites {
					maxWrites = fileWrites[ev.InputHash]
				}
			}
		}
		_ = st.UpdateBaseline("file_hotspot_writes", float64(maxWrites))

		// Distinct files modified.
		distinctFiles := make(map[uint64]bool)
		for _, ev := range events {
			if ev.IsWrite {
				distinctFiles[ev.InputHash] = true
			}
		}
		_ = st.UpdateBaseline("plan_mode_files", float64(len(distinctFiles)))
	}

	// No-progress metrics: tools in burst + elapsed minutes since burst start.
	tc, _, _, _ := sdb.BurstState()
	_ = st.UpdateBaseline("no_progress_tools", float64(tc))

	if startTime, err := sdb.BurstStartTime(); err == nil && !startTime.IsZero() {
		elapsed := time.Since(startTime).Minutes()
		_ = st.UpdateBaseline("no_progress_minutes", elapsed)
	}

	// Compaction burst: record burst tool count at session end as proxy for
	// typical burst size when compaction risk is evaluated.
	compacts, _ := sdb.CompactsInWindow(60)
	if compacts > 0 {
		_ = st.UpdateBaseline("compaction_burst_tools", float64(tc))
	}

	// EWMA error rate.
	errRate := getFloat(sdb, "ewma_error_rate")
	_ = st.UpdateBaseline("debug_error_rate", errRate)

	// Phase distribution metrics.
	phases, err := sdb.GetRawPhaseSequence(20)
	if err == nil && len(phases) > 0 {
		dist := phaseDist(phases)
		_ = st.UpdateBaseline("explore_read_pct", dist["read"])

		editBashCount := countTransitions(phases, "write", "compile") +
			countTransitions(phases, "write", "test")
		_ = st.UpdateBaseline("debug_edit_cycles", float64(editBashCount))
	}
}

// persistUserProfile extracts session-level coding style metrics
// and updates the persistent user profile with EWMA smoothing.
func persistUserProfile(sdb *sessiondb.SessionDB) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	tc, hasWrite, _, _ := sdb.BurstState()
	if tc == 0 {
		return
	}

	// tools_per_burst: total tools in this session burst.
	_ = st.UpdateUserProfile("tools_per_burst", float64(tc))

	// read_write_ratio: proportion of read vs write tools.
	events, err := sdb.RecentEvents(50)
	if err == nil && len(events) > 0 {
		reads, writes := 0, 0
		for _, ev := range events {
			if ev.IsWrite {
				writes++
			} else {
				reads++
			}
		}
		if writes > 0 {
			_ = st.UpdateUserProfile("read_write_ratio", float64(reads)/float64(writes))
		}
	}

	// test_frequency: did the user run tests? (1.0 = yes, 0.0 = no)
	hasTestRun, _ := sdb.GetContext("has_test_run")
	if hasTestRun == "true" {
		_ = st.UpdateUserProfile("test_frequency", 1.0)
	} else if hasWrite {
		_ = st.UpdateUserProfile("test_frequency", 0.0)
	}

	// compact_frequency: number of compactions in this session.
	compacts, _ := sdb.CompactsInWindow(525600) // 1 year — effectively all time in session
	_ = st.UpdateUserProfile("compact_frequency", float64(compacts))

	// avg_session_duration: session length in minutes.
	if startTime, err := sdb.BurstStartTime(); err == nil && !startTime.IsZero() {
		duration := time.Since(startTime).Minutes()
		_ = st.UpdateUserProfile("avg_session_duration", duration)
	}

	// reads_before_write: average number of read tools before the first write.
	if err == nil && len(events) > 0 {
		readsBeforeFirstWrite := 0
		foundWrite := false
		// Events are newest-first; iterate in reverse for chronological order.
		for i := len(events) - 1; i >= 0; i-- {
			if events[i].IsWrite {
				foundWrite = true
				break
			}
			readsBeforeFirstWrite++
		}
		if foundWrite {
			_ = st.UpdateUserProfile("reads_before_write", float64(readsBeforeFirstWrite))
		}
	}

	// test_before_edit: did user run tests before editing? (1.0=yes, 0.0=no)
	if err == nil && len(events) > 0 {
		sawTest := false
		sawWrite := false
		for i := len(events) - 1; i >= 0; i-- {
			name := events[i].ToolName
			if name == "Bash" && !events[i].IsWrite {
				// Approximate: Bash non-write is often a test run.
				sawTest = true
			}
			if events[i].IsWrite && !sawWrite {
				sawWrite = true
				if sawTest {
					_ = st.UpdateUserProfile("test_before_edit", 1.0)
				} else {
					_ = st.UpdateUserProfile("test_before_edit", 0.0)
				}
			}
		}
	}

	// suggestion_follow_rate: fraction of helpful feedback (from feedbacks table).
	if stats, ferr := st.AllFeedbackStats(); ferr == nil && stats.TotalCount > 0 {
		followRate := float64(stats.Helpful) / float64(stats.TotalCount)
		_ = st.UpdateUserProfile("suggestion_follow_rate", followRate)
	}
}

// syncToGlobalDB syncs patterns and decisions from the project store
// to the global cross-project database, and updates the project fingerprint.
func syncToGlobalDB(sdb *sessiondb.SessionDB, cwd string) {
	if cwd == "" {
		cwd, _ = sdb.GetContext("cwd")
	}
	if cwd == "" {
		return
	}

	gs, err := store.OpenGlobal()
	if err != nil {
		return
	}
	defer gs.Close()

	// Update project fingerprint.
	fp := store.GenerateFingerprint(cwd)
	_ = gs.UpsertFingerprint(fp)

	// Sync recent decisions from the project store.
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	decisions, err := st.GetDecisions("", fp.ProjectName, 5)
	if err != nil || len(decisions) == 0 {
		return
	}

	for _, d := range decisions {
		title := d.Topic
		if title == "" {
			title = d.DecisionText
			if len([]rune(title)) > 80 {
				title = string([]rune(title)[:80])
			}
		}
		_ = gs.InsertPattern(fp.ProjectName, "decision", title, d.DecisionText, fp.Languages)
	}
}

// preGenerateCoaching generates AI coaching for the next session and caches it.
// Uses the current session's rich context for personalized SITUATION/WHY/SUGGESTION coaching.
func preGenerateCoaching(sdb *sessiondb.SessionDB, cwd string) {
	if cwd == "" {
		return
	}

	taskType, _ := sdb.GetContext("task_type")
	domain, _ := sdb.GetWorkingSet("domain")
	if taskType == "" {
		return
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	// Build rich coaching context from session state.
	cc := coach.CoachingContext{
		TaskType:    taskType,
		Domain:      domain,
		UserCluster: st.UserCluster(),
	}

	if intent, _ := sdb.GetWorkingSet("intent"); intent != "" {
		cc.Intent = intent
	}
	if files, _ := sdb.GetWorkingSetFiles(); len(files) > 0 {
		cc.Files = files
	}
	if decisions, _ := sdb.GetWorkingSetDecisions(); len(decisions) > 0 {
		limit := len(decisions)
		if limit > 3 {
			limit = 3
		}
		cc.Decisions = decisions[:limit]
	}

	// Gather recent error summaries from structured events.
	if errEvents, _ := sdb.GetStructuredEventsByCategory("error"); len(errEvents) > 0 {
		limit := len(errEvents)
		if limit > 3 {
			limit = 3
		}
		for _, e := range errEvents[:limit] {
			cc.RecentErrors = append(cc.RecentErrors, e.Summary)
		}
	}

	// Gather related pattern titles.
	patterns, _ := st.SearchPatternsByProject(cwd, 3)
	for _, p := range patterns {
		cc.PastPatterns = append(cc.PastPatterns, p.Title)
	}

	ctx := context.Background()
	result, err := coach.GenerateCoachingWithContext(ctx, sdb, cc, 5*time.Second)
	if err != nil || result == nil {
		return
	}

	// Format as labeled text for cache storage.
	var text string
	if result.Situation != "" {
		text = fmt.Sprintf("SITUATION: %s\nWHY: %s\nSUGGESTION: %s",
			result.Situation, result.Reasoning, result.Suggestion)
	} else {
		text = result.Suggestion
	}

	_ = st.SetCachedCoaching(cwd, taskType, domain, text, "")
}

// extractPatternsWithLLM uses the coach package to extract reusable knowledge
// from the session's recent events via `claude -p`. Results are persisted to buddy.db.
// Gracefully skips if claude CLI is not available or on timeout.
func extractPatternsWithLLM(sdb *sessiondb.SessionDB, sessionID string) {
	summary := buildExtractionSummary(sdb)
	if summary == "" {
		return
	}

	ctx := context.Background()
	results, err := coach.ExtractPatterns(ctx, sdb, summary, 5*time.Second)
	if err != nil || len(results) == 0 {
		return
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	for _, r := range results {
		p := &store.PatternRow{
			SessionID:   sessionID,
			PatternType: r.Type,
			Title:       r.Title,
			Content:     r.Content,
			EmbedText:   r.Title + " " + r.Content,
			Language:    "en",
			Scope:       "project",
			Timestamp:   now,
			Tags:        []string{r.Type, "llm-extracted"},
		}
		_, _ = st.InsertPattern(p)
	}
}

// buildExtractionSummary builds a rich session summary for LLM pattern extraction.
// Combines working set context, structured events, tool sequence, and decisions.
func buildExtractionSummary(sdb *sessiondb.SessionDB) string {
	events, err := sdb.RecentEvents(50)
	if err != nil || len(events) == 0 {
		return ""
	}

	var b strings.Builder

	// Section 1: Session context from working set.
	b.WriteString("## Session Summary\n")
	if intent, _ := sdb.GetWorkingSet("intent"); intent != "" {
		fmt.Fprintf(&b, "- Task: %s\n", intent)
	}
	if taskType, _ := sdb.GetContext("task_type"); taskType != "" {
		fmt.Fprintf(&b, "- Task Type: %s\n", taskType)
	}
	if domain, _ := sdb.GetWorkingSet("domain"); domain != "" {
		fmt.Fprintf(&b, "- Domain: %s\n", domain)
	}
	if branch, _ := sdb.GetWorkingSet("git_branch"); branch != "" {
		fmt.Fprintf(&b, "- Git Branch: %s\n", branch)
	}
	if files, _ := sdb.GetWorkingSetFiles(); len(files) > 0 {
		b.WriteString("- Files Modified:")
		limit := len(files)
		if limit > 10 {
			limit = 10
		}
		for _, f := range files[:limit] {
			fmt.Fprintf(&b, " %s", filepath.Base(f))
		}
		b.WriteString("\n")
	}

	// Section 2: Structured events (errors, fixes, decisions, discoveries).
	structuredEvents, _ := sdb.GetStructuredEvents()
	if len(structuredEvents) > 0 {
		b.WriteString("\n## Key Events\n")
		limit := len(structuredEvents)
		if limit > 15 {
			limit = 15
		}
		for _, se := range structuredEvents[:limit] {
			fmt.Fprintf(&b, "[%s] %s\n", se.Category, se.Summary)
		}
	}

	// Section 3: Abbreviated tool sequence.
	b.WriteString("\n## Tool Sequence\n")
	prevTool := ""
	repeatCount := 0
	for _, ev := range events {
		name := ev.ToolName
		if ev.IsWrite {
			name += "[w]"
		}
		if name == prevTool {
			repeatCount++
			continue
		}
		if prevTool != "" {
			if repeatCount > 0 {
				fmt.Fprintf(&b, "%s(x%d)→", prevTool, repeatCount+1)
			} else {
				b.WriteString(prevTool + "→")
			}
		}
		prevTool = name
		repeatCount = 0
	}
	if prevTool != "" {
		if repeatCount > 0 {
			fmt.Fprintf(&b, "%s(x%d)", prevTool, repeatCount+1)
		} else {
			b.WriteString(prevTool)
		}
	}
	b.WriteString("\n")

	// Section 4: Decisions from working set.
	if decisions, _ := sdb.GetWorkingSetDecisions(); len(decisions) > 0 {
		b.WriteString("\n## Decisions Made\n")
		limit := len(decisions)
		if limit > 5 {
			limit = 5
		}
		for _, d := range decisions[:limit] {
			fmt.Fprintf(&b, "- %s\n", d)
		}
	}

	return b.String()
}

// RecoverOrphanedSessions scans /tmp/claude-buddy/ for session DBs
// that were not properly destroyed (SessionEnd never fired).
// Extracts and persists their data, then destroys them.
// Skips the current session. Returns the number of recovered sessions.
func RecoverOrphanedSessions(currentSessionID, cwd string) int {
	dir := filepath.Join(os.TempDir(), "claude-buddy")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}

	recovered := 0
	const maxRecover = 5

	for _, e := range entries {
		if recovered >= maxRecover {
			break
		}
		name := e.Name()
		if !strings.HasPrefix(name, "session-") || !strings.HasSuffix(name, ".db") {
			continue
		}
		// Skip WAL and SHM files.
		if strings.HasSuffix(name, "-wal") || strings.HasSuffix(name, "-shm") {
			continue
		}

		sessionID := strings.TrimPrefix(strings.TrimSuffix(name, ".db"), "session-")
		if sessionID == currentSessionID {
			continue
		}

		// Persist whatever knowledge the orphaned session accumulated.
		persistSessionData(sessionID, cwd)

		// Clean up live data and destroy the session DB.
		if st, serr := store.OpenDefaultCached(); serr == nil {
			_ = st.CleanupLiveSession(sessionID)
		}
		if sdb, serr := sessiondb.Open(sessionID); serr == nil {
			_ = sdb.Destroy()
			recovered++
		}
	}

	return recovered
}
