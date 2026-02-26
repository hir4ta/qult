package hookhandler

import (
	"fmt"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// Phase represents a recognized development phase within a session.
type Phase string

const (
	PhaseExplore   Phase = "explore"
	PhaseReproduce Phase = "reproduce"
	PhaseDiagnose  Phase = "diagnose"
	PhaseDesign    Phase = "design"
	PhasePlan      Phase = "plan"
	PhaseImplement Phase = "implement"
	PhaseTest      Phase = "test"
	PhaseVerify    Phase = "verify"
	PhaseRefine    Phase = "refine"
	PhaseUnknown   Phase = ""
)

// taskPhaseSequences defines the expected phase ordering per task type.
var taskPhaseSequences = map[TaskType][]Phase{
	TaskBugfix:   {PhaseExplore, PhaseReproduce, PhaseDiagnose, PhaseImplement, PhaseVerify},
	TaskFeature:  {PhaseExplore, PhaseDesign, PhaseImplement, PhaseTest, PhaseRefine},
	TaskRefactor: {PhaseExplore, PhasePlan, PhaseImplement, PhaseVerify},
	TaskTest:     {PhaseExplore, PhaseImplement, PhaseVerify},
}

// phaseToolMap maps tool names to their likely phase.
var phaseToolMap = map[string]Phase{
	"Read":          PhaseExplore,
	"Grep":          PhaseExplore,
	"Glob":          PhaseExplore,
	"Edit":          PhaseImplement,
	"Write":         PhaseImplement,
	"NotebookEdit":  PhaseImplement,
	"EnterPlanMode": PhaseDesign,
}

// PhaseProgress represents where we are in the task lifecycle.
type PhaseProgress struct {
	TaskType        TaskType
	CurrentPhase    Phase
	ExpectedPhase   Phase
	CompletedPhases []Phase
	RemainingPhases []Phase
	ProgressPct     int
}

// classifyCurrentPhase determines the current phase from recent tool activity.
// Uses a sliding window of the last 5 tool events and majority vote.
func classifyCurrentPhase(sdb *sessiondb.SessionDB, _ TaskType) Phase {
	events, err := sdb.RecentEvents(5)
	if err != nil || len(events) == 0 {
		return PhaseUnknown
	}

	counts := make(map[Phase]int)
	for _, ev := range events {
		if ev.ToolName == "Bash" {
			// Distinguish test/verify from other bash usage.
			phase := classifyBashToolPhase(sdb, ev.ToolName)
			counts[phase]++
		} else if p, ok := phaseToolMap[ev.ToolName]; ok {
			counts[p]++
		}
	}

	// Find dominant phase.
	var best Phase
	bestCount := 0
	for p, c := range counts {
		if c > bestCount {
			best = p
			bestCount = c
		}
	}
	return best
}

// classifyBashToolPhase determines whether a Bash event is test/verify/other.
func classifyBashToolPhase(sdb *sessiondb.SessionDB, _ string) Phase {
	hasTestRun, _ := sdb.GetContext("has_test_run")
	if hasTestRun == "true" {
		return PhaseVerify
	}
	return PhaseTest
}

// GetPhaseProgress returns the current phase progress for the session.
func GetPhaseProgress(sdb *sessiondb.SessionDB) *PhaseProgress {
	taskTypeStr, _ := sdb.GetContext("task_type")
	if taskTypeStr == "" {
		return nil
	}
	taskType := TaskType(taskTypeStr)

	expected, ok := taskPhaseSequences[taskType]
	if !ok {
		return nil
	}

	current := classifyCurrentPhase(sdb, taskType)

	// Determine completed phases from session_phases history.
	rawPhases, _ := sdb.GetRawPhaseSequence(20)
	seen := make(map[Phase]bool)
	var completed []Phase
	for _, raw := range rawPhases {
		p := mapRawToPhase(raw)
		if p != PhaseUnknown && !seen[p] {
			seen[p] = true
			completed = append(completed, p)
		}
	}

	// Calculate remaining and progress.
	var remaining []Phase
	for _, p := range expected {
		if !seen[p] {
			remaining = append(remaining, p)
		}
	}

	pct := 0
	if len(expected) > 0 {
		pct = min(len(completed)*100/len(expected), 100)
	}

	// Expected next phase.
	var expectedPhase Phase
	if len(remaining) > 0 {
		expectedPhase = remaining[0]
	}

	return &PhaseProgress{
		TaskType:        taskType,
		CurrentPhase:    current,
		ExpectedPhase:   expectedPhase,
		CompletedPhases: completed,
		RemainingPhases: remaining,
		ProgressPct:     pct,
	}
}

// mapRawToPhase converts raw phase strings (from session_phases) to Phase constants.
func mapRawToPhase(raw string) Phase {
	switch strings.ToLower(raw) {
	case "read", "explore":
		return PhaseExplore
	case "write", "implement":
		return PhaseImplement
	case "test":
		return PhaseTest
	case "compile", "verify":
		return PhaseVerify
	case "design", "plan":
		return PhaseDesign
	default:
		return PhaseUnknown
	}
}

// shouldGateForPhase returns true if a suggestion is inappropriate for the current phase.
func shouldGateForPhase(sdb *sessiondb.SessionDB, pattern string) bool {
	progress := GetPhaseProgress(sdb)
	if progress == nil || progress.CurrentPhase == PhaseUnknown {
		return false
	}

	switch pattern {
	case "workflow":
		return progress.CurrentPhase == PhaseExplore
	case "test-first":
		return progress.CurrentPhase != PhaseImplement && progress.CurrentPhase != PhaseVerify
	case "file-knowledge":
		return progress.CurrentPhase == PhaseVerify
	}
	return false
}

// buildWallIntervention creates a context-rich suggestion when velocity drops sharply.
func buildWallIntervention(sdb *sessiondb.SessionDB) string {
	var b strings.Builder
	b.WriteString("Your productivity velocity dropped significantly. Consider:")

	intent, _ := sdb.GetWorkingSet("intent")
	if intent != "" {
		fmt.Fprintf(&b, "\n  - Review your intent: %s", intent)
	}

	progress := GetPhaseProgress(sdb)
	if progress != nil {
		switch progress.CurrentPhase {
		case PhaseImplement:
			b.WriteString("\n  - Step back: re-read related code or check test output")
		case PhaseExplore:
			b.WriteString("\n  - Narrow focus: pick one file/function to investigate")
		}
		if progress.ExpectedPhase != PhaseUnknown && progress.ExpectedPhase != progress.CurrentPhase {
			fmt.Fprintf(&b, "\n  - Expected next phase: %s", progress.ExpectedPhase)
		}
	}

	b.WriteString("\n  - Try a different approach or break the problem into smaller steps")
	return b.String()
}
