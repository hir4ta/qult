package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

type userPromptInput struct {
	CommonInput
	Prompt string `json:"prompt"`
}

func handleUserPromptSubmit(input []byte) (*HookOutput, error) {
	var in userPromptInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] UserPromptSubmit: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// Record unresolved nudge feedback before resetting burst state.
	recordUnresolvedFeedback(sdb)

	// User turn boundary: reset burst counters and context.
	_ = sdb.ResetBurst()
	_ = sdb.SetContext("subagent_active", "")

	// Record user intent and classify task type for workflow guidance.
	var taskBriefing string
	if in.Prompt != "" {
		intent := in.Prompt
		if len([]rune(intent)) > 100 {
			intent = string([]rune(intent)[:100])
		}
		_ = sdb.SetContext("last_user_intent", intent)

		taskType := classifyIntent(in.Prompt)
		if taskType != TaskUnknown {
			// Detect intent transition: track when task_type changes mid-session.
			prevTaskType, _ := sdb.GetContext("task_type")
			isTransition := prevTaskType != "" && prevTaskType != string(taskType)
			isFirstClassification := prevTaskType == ""

			if isTransition {
				transition := prevTaskType + " → " + string(taskType)
				_ = sdb.SetWorkingSet("intent_transition", transition)
				_ = sdb.SetContext("intent_transition_count",
					incrementContextInt(sdb, "intent_transition_count"))
			}
			_ = sdb.SetContext("task_type", string(taskType))

			// Generate briefing on task transition or first classification.
			if isTransition || isFirstClassification {
				taskBriefing = generateTaskTransitionBriefing(sdb, prevTaskType, string(taskType), in.CWD)
			}
		}
		_ = sdb.SetContext("has_test_run", "")

		// Update working set with current intent and task type.
		_ = sdb.SetWorkingSet("intent", intent)
		if taskType != TaskUnknown {
			_ = sdb.SetWorkingSet("task_type", string(taskType))
		}

		// Domain classification from prompt + file context fallback.
		domain := detectDomain(in.Prompt)
		if domain == "general" {
			domain = inferDomainFromFiles(sdb)
		}
		_ = sdb.SetWorkingSet("domain", domain)

		// Track decisions from user prompts.
		if containsDecisionKeyword(in.Prompt) {
			_ = sdb.AddWorkingSetDecision(intent)
		}
	}

	// Dequeue pending nudges to prevent pile-up and record delivery.
	nudges, _ := sdb.DequeueNudges(2)
	recordNudgeDelivery(sdb, in.SessionID, nudges)

	// Track implicit feedback: if Claude hasn't called buddy MCP tools recently,
	// record as a signal that current suggestions may not be valuable enough.
	trackImplicitFeedback(sdb, in.SessionID)

	// Lightweight mode: skip JARVIS briefing during subagent activity.
	if sdb.ActiveSubagentCount() > 0 {
		return nil, nil
	}

	// --- JARVIS briefing: select the single most important signal ---
	var entries []nudgeEntry

	// 0. Predictive context: predict target files from prompt and surface proactive hints.
	if predictiveHint := buildPredictiveContext(sdb, in.Prompt); predictiveHint != "" {
		entries = append(entries, nudgeEntry{
			Pattern:     "predictive-context",
			Level:       "info",
			Observation: "Predictive context",
			Suggestion:  predictiveHint,
		})
	}

	// 1. JARVIS briefing signal (max 1, priority-based).
	// Use narrative synthesis to enrich the signal with session context.
	if sig := selectTopSignal(sdb, in.Prompt, in.CWD); sig != nil {
		detail := buildNarrative(sig, sdb)
		briefing := fmt.Sprintf("[buddy:briefing] %s", detail)
		entries = append(entries, nudgeEntry{
			Pattern:     "briefing",
			Level:       "insight",
			Observation: "JARVIS briefing",
			Suggestion:  briefing,
		})
	}

	// 2. Queued nudges from other hooks (PostToolUse etc.).
	for _, n := range nudges {
		entries = append(entries, nudgeEntry{
			Pattern:     n.Pattern,
			Level:       n.Level,
			Observation: n.Observation,
			Suggestion:  n.Suggestion,
		})
	}

	// 3. Task transition briefing (one-time event, not noise).
	if taskBriefing != "" {
		entries = append([]nudgeEntry{{
			Pattern:     "task-briefing",
			Level:       "info",
			Observation: "Task brief",
			Suggestion:  taskBriefing,
		}}, entries...)
	}

	// 4. Session context summary (compact one-liner, cooldown-gated).
	if summary := buildSessionContextSummary(sdb); summary != "" {
		entries = append([]nudgeEntry{{
			Pattern:     "session-context",
			Level:       "info",
			Observation: "Session context",
			Suggestion:  summary,
		}}, entries...)
	}

	if len(entries) == 0 {
		return nil, nil
	}
	return makeOutput("UserPromptSubmit", formatNudges(entries)), nil
}

// buildSessionContextSummary creates a compact session context string.
func buildSessionContextSummary(sdb *sessiondb.SessionDB) string {
	on, _ := sdb.IsOnCooldown("session_context_summary")
	if on {
		return ""
	}

	var parts []string

	// Working files.
	files, _ := sdb.GetWorkingSetFiles()
	if len(files) > 0 {
		names := make([]string, 0, min(len(files), 3))
		for i, f := range files {
			if i >= 3 {
				break
			}
			names = append(names, filepath.Base(f))
		}
		suffix := ""
		if len(files) > 3 {
			suffix = fmt.Sprintf(" +%d more", len(files)-3)
		}
		parts = append(parts, "Files: "+strings.Join(names, ", ")+suffix)
	}

	// Task type + phase progress.
	if progress := GetPhaseProgress(sdb); progress != nil {
		phaseStr := fmt.Sprintf("Phase: %s (%d%%)", progress.CurrentPhase, progress.ProgressPct)
		if progress.ExpectedPhase != PhaseUnknown && progress.ExpectedPhase != progress.CurrentPhase {
			phaseStr += fmt.Sprintf(" → next: %s", progress.ExpectedPhase)
		}
		parts = append(parts, phaseStr)
	} else if taskType, _ := sdb.GetContext("task_type"); taskType != "" {
		parts = append(parts, "Task: "+taskType)
	}

	// Git branch.
	if branch, _ := sdb.GetWorkingSet("git_branch"); branch != "" {
		parts = append(parts, "Branch: "+branch)
	}

	// Unresolved failures: critical signal.
	failures, _ := sdb.RecentFailures(5)
	unresolvedCount := 0
	for _, f := range failures {
		if time.Since(f.Timestamp) > 10*time.Minute || f.FilePath == "" {
			continue
		}
		if unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath); unresolved {
			unresolvedCount++
		}
	}
	if unresolvedCount > 0 {
		parts = append(parts, fmt.Sprintf("UNRESOLVED: %d failure(s)", unresolvedCount))
	}

	// Test status.
	hasTestRun, _ := sdb.GetContext("has_test_run")
	lastTestPassed, _ := sdb.GetContext("last_test_passed")
	if hasTestRun == "true" {
		if lastTestPassed == "false" {
			parts = append(parts, "Tests: FAILING")
		} else {
			parts = append(parts, "Tests: passing")
		}
	} else if len(files) > 0 {
		parts = append(parts, "Tests: not run yet")
	}

	// Velocity health.
	vel := getFloat(sdb, "ewma_tool_velocity")
	errRate := getFloat(sdb, "ewma_error_rate")
	if vel > 0 || errRate > 0 {
		health := "healthy"
		if errRate > 0.3 {
			health = "high error rate"
		} else if vel < 2 && vel > 0 {
			health = "slow velocity"
		}
		parts = append(parts, "Health: "+health)
	}

	// Co-change candidates: files frequently changed together but not yet modified.
	if len(files) > 0 && len(files) <= 5 {
		if coHint := coChangeCandidates(files); coHint != "" {
			parts = append(parts, coHint)
		}
	}

	// Data maturity: signal when buddy is still learning.
	if label := dataMaturityLabel(sdb); label != "" {
		parts = append(parts, "buddy: "+label)
	}

	if len(parts) < 2 {
		return "" // not enough context to be useful
	}

	_ = sdb.SetCooldown("session_context_summary", 2*time.Minute)
	return strings.Join(parts, " | ")
}

// coChangeCandidates checks if any working set files have frequent co-change partners
// that haven't been modified yet. Returns a compact hint or "".
func coChangeCandidates(files []string) string {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

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
		return ""
	}
	return "Co-change: also check " + strings.Join(missing, ", ")
}

// knowledgeType pairs a pattern type with its cooldown key.
type knowledgeType struct {
	name     string
	cooldown string
}

var knowledgeTypes = []knowledgeType{
	{"error_solution", "knowledge_error"},
	{"architecture", "knowledge_arch"},
	{"decision", "knowledge_decision"},
}

// findKnowledgeSignal searches past patterns matching the user's prompt via
// semantic vector search. Returns a P2 Signal when relevant knowledge is found.
// Uses split cooldowns per knowledge type and falls back to file-path keywords
// when the prompt is short.
func findKnowledgeSignal(sdb *sessiondb.SessionDB, prompt string) *Signal {
	if prompt == "" {
		return nil
	}

	on, _ := sdb.IsOnCooldown("briefing_knowledge")
	if on {
		return nil
	}

	// Build search terms: keywords from prompt + recent file paths as fallback.
	keywords := extractKeywords(prompt, 3)
	if len(keywords) == 0 {
		keywords = recentFileKeywords(sdb)
	}
	if len(keywords) == 0 {
		return nil
	}

	// Prioritize knowledge types based on task type.
	taskTypeStr, _ := sdb.GetContext("task_type")
	ordered := prioritizeKnowledgeTypes(TaskType(taskTypeStr))

	// Check at least one knowledge type is off cooldown.
	var activeTypes []string
	for _, t := range ordered {
		typeOn, _ := sdb.IsOnCooldown(t.cooldown)
		if !typeOn {
			activeTypes = append(activeTypes, t.name)
		}
	}
	if len(activeTypes) == 0 {
		return nil
	}

	query := strings.Join(keywords, " ")
	vec := embedQuery(sdb, query, 1*time.Second)

	st, err := store.OpenDefaultCached()
	if err != nil {
		return nil
	}

	var allResults []store.PatternRow
	for _, patType := range activeTypes {
		if vec != nil {
			patterns, _ := st.SearchPatternsByVector(vec, patType, 2)
			allResults = append(allResults, patterns...)
		} else {
			// FTS5 fallback when embedder is unavailable.
			patterns, _ := st.SearchPatternsByFTS(query, patType, 2)
			if len(patterns) == 0 {
				patterns, _ = st.SearchPatternsByKeyword(query, patType, 2)
			}
			allResults = append(allResults, patterns...)
		}
	}
	if len(allResults) == 0 {
		return nil
	}

	// Re-rank by task-type and domain affinity.
	domain, _ := sdb.GetWorkingSet("domain")
	allResults = store.RankPatterns(allResults, &store.RankContext{
		TaskType: taskTypeStr,
		Domain:   domain,
	})

	// Set cooldowns for matched types.
	matchedTypes := make(map[string]bool)
	for _, p := range allResults {
		matchedTypes[p.PatternType] = true
	}
	for _, t := range knowledgeTypes {
		if matchedTypes[t.name] {
			_ = sdb.SetCooldown(t.cooldown, 3*time.Minute)
		}
	}

	_ = sdb.SetCooldown("briefing_knowledge", 5*time.Minute)

	var b strings.Builder
	b.WriteString("Relevant past knowledge:\n")
	limit := min(3, len(allResults))
	for i := 0; i < limit; i++ {
		p := allResults[i]
		content := p.Content
		if len([]rune(content)) > 120 {
			content = string([]rune(content)[:120]) + "..."
		}
		fmt.Fprintf(&b, "  - [%s] %s\n", p.PatternType, content)
	}
	return &Signal{Priority: 2, Kind: "knowledge", Detail: b.String()}
}

// prioritizeKnowledgeTypes reorders knowledge types based on task type.
// bugfix → error_solution first, feature → architecture first, refactor → decision first.
func prioritizeKnowledgeTypes(taskType TaskType) []knowledgeType {
	switch taskType {
	case TaskBugfix:
		return []knowledgeType{
			{"error_solution", "knowledge_error"},
			{"decision", "knowledge_decision"},
			{"architecture", "knowledge_arch"},
		}
	case TaskFeature:
		return []knowledgeType{
			{"architecture", "knowledge_arch"},
			{"decision", "knowledge_decision"},
			{"error_solution", "knowledge_error"},
		}
	case TaskRefactor:
		return []knowledgeType{
			{"decision", "knowledge_decision"},
			{"architecture", "knowledge_arch"},
			{"error_solution", "knowledge_error"},
		}
	default:
		return knowledgeTypes
	}
}

// incrementContextInt reads an integer context value, increments it, and returns the new string.
func incrementContextInt(sdb *sessiondb.SessionDB, key string) string {
	v, _ := sdb.GetContext(key)
	n, _ := strconv.Atoi(v)
	return strconv.Itoa(n + 1)
}

// recentFileKeywords extracts searchable keywords from recent file paths
// in the current burst, used as a fallback when the user prompt is short.
func recentFileKeywords(sdb *sessiondb.SessionDB) []string {
	_, _, fileReads, err := sdb.BurstState()
	if err != nil || len(fileReads) == 0 {
		return nil
	}

	var keywords []string
	seen := make(map[string]bool)
	for path := range fileReads {
		base := filepath.Base(path)
		name := strings.TrimSuffix(base, filepath.Ext(base))
		if len(name) >= 3 && !seen[name] {
			seen[name] = true
			keywords = append(keywords, name)
		}
		if len(keywords) >= 3 {
			break
		}
	}
	return keywords
}

// predictTargetFiles predicts which files the user is likely to edit based on
// the prompt content, working set, and co-change history.
func predictTargetFiles(sdb *sessiondb.SessionDB, prompt string) []string {
	var predicted []string
	seen := make(map[string]bool)

	// 1. Extract file paths and package names from the prompt.
	for _, word := range strings.Fields(prompt) {
		// Match file-like tokens: contains '/' or common extensions.
		if strings.Contains(word, "/") || strings.Contains(word, ".go") ||
			strings.Contains(word, ".ts") || strings.Contains(word, ".py") ||
			strings.Contains(word, ".rs") {
			clean := strings.Trim(word, ".,;:\"'`()")
			if clean != "" && !seen[clean] {
				seen[clean] = true
				predicted = append(predicted, clean)
			}
		}
	}

	// 2. Include current working set files.
	wsFiles, _ := sdb.GetWorkingSetFiles()
	for _, f := range wsFiles {
		if !seen[f] {
			seen[f] = true
			predicted = append(predicted, f)
		}
	}

	// 3. Expand with co-change partners.
	st, err := store.OpenDefaultCached()
	if err != nil {
		if len(predicted) > 3 {
			return predicted[:3]
		}
		return predicted
	}

	var cochanged []string
	for _, f := range predicted {
		coFiles, _ := st.CoChangedFiles(f, 2)
		for _, co := range coFiles {
			peer := co.FileA
			if peer == f {
				peer = co.FileB
			}
			if !seen[peer] {
				seen[peer] = true
				cochanged = append(cochanged, peer)
			}
		}
	}
	predicted = append(predicted, cochanged...)

	if len(predicted) > 5 {
		predicted = predicted[:5]
	}
	return predicted
}

// buildPredictiveContext uses predicted target files to proactively surface
// relevant warnings and context. Returns "" if no useful prediction.
func buildPredictiveContext(sdb *sessiondb.SessionDB, prompt string) string {
	on, _ := sdb.IsOnCooldown("predictive_context")
	if on {
		return ""
	}

	predicted := predictTargetFiles(sdb, prompt)
	if len(predicted) == 0 {
		return ""
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

	var hints []string

	// Search for past failure solutions on predicted files.
	for _, f := range predicted {
		solutions, _ := st.SearchFailureSolutionsByFile(f, 1)
		if len(solutions) > 0 {
			sol := solutions[0]
			hint := fmt.Sprintf("Past failure in %s: %s", filepath.Base(f), sol.SolutionText)
			if len([]rune(hint)) > 150 {
				hint = string([]rune(hint)[:150]) + "..."
			}
			hints = append(hints, hint)
			break // max 1 failure hint
		}
	}

	// Suggest related tests for predicted files.
	cm := LoadCoverageMap(sdb)
	if cm != nil {
		for _, f := range predicted {
			if filepath.Ext(f) == ".go" && !strings.HasSuffix(f, "_test.go") {
				if cmd := SuggestTestCommand(cm, f, nil, ""); cmd != "" {
					hints = append(hints, "Related test: "+cmd)
					break // max 1 test hint
				}
			}
		}
	}

	// Surface co-change files not yet in working set.
	wsFiles, _ := sdb.GetWorkingSetFiles()
	wsSet := make(map[string]bool, len(wsFiles))
	for _, f := range wsFiles {
		wsSet[f] = true
	}
	var missing []string
	for _, f := range predicted {
		if !wsSet[f] {
			missing = append(missing, filepath.Base(f))
		}
	}
	if len(missing) > 0 && len(missing) <= 3 {
		hints = append(hints, "Predicted files: "+strings.Join(missing, ", "))
	}

	if len(hints) == 0 {
		return ""
	}

	_ = sdb.SetCooldown("predictive_context", 5*time.Minute)
	return "[buddy:predict] " + strings.Join(hints, " | ")
}

// dataMaturityLabel returns a short label indicating buddy's data maturity level.
// Returns "" when mature (silence is healthy).
func dataMaturityLabel(sdb *sessiondb.SessionDB) string {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

	sessionCount := 0
	if stats, err := st.GetProjectSessionStats(""); err == nil && stats != nil {
		sessionCount = stats.TotalSessions
	}

	patternCount, _ := st.CountPatterns()

	switch {
	case sessionCount < 3:
		return fmt.Sprintf("Learning (session %d/3)", sessionCount)
	case patternCount < 10:
		return fmt.Sprintf("Growing (%d patterns)", patternCount)
	default:
		return ""
	}
}
