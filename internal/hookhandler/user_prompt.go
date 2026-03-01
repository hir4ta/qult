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

// promptContext caches frequently-queried data within a single handleUserPromptSubmit call.
// Fields are lazily populated on first access. Not safe for concurrent use.
type promptContext struct {
	sdb *sessiondb.SessionDB

	wsFiles     []string
	wsFilesDone bool

	failures     []sessiondb.FailureEntry
	failuresDone bool

	phase     *PhaseProgress
	phaseDone bool

	ewmaVel  float64
	ewmaErr  float64
	ewmaDone bool
}

func newPromptContext(sdb *sessiondb.SessionDB) *promptContext {
	return &promptContext{sdb: sdb}
}

// WorkingSetFiles returns cached working set files (fetched once per invocation).
func (pc *promptContext) WorkingSetFiles() []string {
	if !pc.wsFilesDone {
		pc.wsFiles, _ = pc.sdb.GetWorkingSetFiles()
		pc.wsFilesDone = true
	}
	return pc.wsFiles
}

// RecentFailures returns cached recent failures, sliced to the requested limit.
func (pc *promptContext) RecentFailures(limit int) []sessiondb.FailureEntry {
	if !pc.failuresDone {
		pc.failures, _ = pc.sdb.RecentFailures(5) // max limit across all callers
		pc.failuresDone = true
	}
	if limit >= len(pc.failures) {
		return pc.failures
	}
	return pc.failures[:limit]
}

// PhaseProgress returns cached phase progress.
func (pc *promptContext) PhaseProgress() *PhaseProgress {
	if !pc.phaseDone {
		pc.phase = GetPhaseProgress(pc.sdb)
		pc.phaseDone = true
	}
	return pc.phase
}

// EWMAVelocity returns cached EWMA tool velocity.
func (pc *promptContext) EWMAVelocity() float64 {
	pc.loadEWMA()
	return pc.ewmaVel
}

// EWMAErrorRate returns cached EWMA error rate.
func (pc *promptContext) EWMAErrorRate() float64 {
	pc.loadEWMA()
	return pc.ewmaErr
}

func (pc *promptContext) loadEWMA() {
	if !pc.ewmaDone {
		pc.ewmaVel = getFloat(pc.sdb, "ewma_tool_velocity")
		pc.ewmaErr = getFloat(pc.sdb, "ewma_error_rate")
		pc.ewmaDone = true
	}
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

	// Lightweight mode: skip all processing for agent sessions.
	if isAgent, _ := sdb.GetContext("is_agent_session"); isAgent == "true" {
		return nil, nil
	}

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
		// Classify and cache task complexity for delivery gating.
		complexity := classifyComplexity(in.Prompt, taskType)
		_ = sdb.SetContext("task_complexity", string(complexity))

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

	// Track implicit feedback: if Claude hasn't called buddy MCP tools recently,
	// record as a signal that current suggestions may not be valuable enough.
	trackImplicitFeedback(sdb, in.SessionID)

	// Lightweight mode: skip JARVIS briefing during subagent activity.
	if sdb.ActiveSubagentCount() > 0 {
		return nil, nil
	}

	pc := newPromptContext(sdb)
	var entries []nudgeEntry

	// 2. Task transition briefing (one-time event, not noise).
	if taskBriefing != "" {
		entries = append([]nudgeEntry{{
			Pattern:     "task-briefing",
			Level:       "info",
			Observation: "Task brief",
			Suggestion:  taskBriefing,
		}}, entries...)
	}

	// 4. Session context summary (compact one-liner, cooldown-gated).
	if summary := buildSessionContextSummary(pc); summary != "" {
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
	out := makeOutput("UserPromptSubmit", formatNudges(entries))
	for _, e := range entries {
		if tool := suggestedToolForPattern(e.Pattern); tool != "" {
			enrichOutput(out, tool)
			break
		}
	}
	return out, nil
}

// buildSessionContextSummary creates a compact session context string.
func buildSessionContextSummary(pc *promptContext) string {
	sdb := pc.sdb
	on, _ := sdb.IsOnCooldown("session_context_summary")
	if on {
		return ""
	}

	var parts []string

	// Working files.
	files := pc.WorkingSetFiles()
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
	if progress := pc.PhaseProgress(); progress != nil {
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
	failures := pc.RecentFailures(5)
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
	vel := pc.EWMAVelocity()
	errRate := pc.EWMAErrorRate()
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


// incrementContextInt reads an integer context value, increments it, and returns the new string.
func incrementContextInt(sdb *sessiondb.SessionDB, key string) string {
	v, _ := sdb.GetContext(key)
	n, _ := strconv.Atoi(v)
	return strconv.Itoa(n + 1)
}
