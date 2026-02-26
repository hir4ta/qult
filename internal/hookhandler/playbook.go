package hookhandler

import (
	"fmt"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// PlaybookStep describes a single step in a recommended workflow.
type PlaybookStep struct {
	Action        string // e.g., "Run failing test to reproduce"
	ToolHint      string // e.g., "Bash(go test)"
	DoneWhen      string // completion criteria, e.g., "Test output shows the expected failure"
	AlternativeIf string // fallback if stuck, e.g., "If no test exists, write a minimal reproduction"
}

// defaultPlaybooks provides hard-coded fallback workflows per task type.
var defaultPlaybooks = map[TaskType][]PlaybookStep{
	TaskBugfix: {
		{Action: "Run failing test to reproduce", ToolHint: "Bash",
			DoneWhen: "Test output shows the expected failure", AlternativeIf: "If no test exists, write a minimal reproduction"},
		{Action: "Read error output and trace to source", ToolHint: "Read",
			DoneWhen: "Root cause file and line identified"},
		{Action: "Edit the fix", ToolHint: "Edit",
			DoneWhen: "Code change targets the root cause", AlternativeIf: "If fix is unclear, add debug logging first"},
		{Action: "Re-run test to verify", ToolHint: "Bash",
			DoneWhen: "Previously failing test now passes"},
		{Action: "Run full test suite", ToolHint: "Bash",
			DoneWhen: "All tests pass with no regressions"},
	},
	TaskFeature: {
		{Action: "Plan the approach", ToolHint: "EnterPlanMode",
			DoneWhen: "Plan approved with clear scope", AlternativeIf: "If scope is small, skip plan and start reading"},
		{Action: "Read existing related code", ToolHint: "Read",
			DoneWhen: "Integration points and patterns understood"},
		{Action: "Implement the feature", ToolHint: "Edit/Write",
			DoneWhen: "Core logic implemented and compiles"},
		{Action: "Add tests", ToolHint: "Write",
			DoneWhen: "Happy path and edge cases covered"},
		{Action: "Run tests", ToolHint: "Bash",
			DoneWhen: "All tests pass including new ones"},
	},
	TaskRefactor: {
		{Action: "Run tests to establish baseline", ToolHint: "Bash",
			DoneWhen: "All existing tests pass"},
		{Action: "Read target code", ToolHint: "Read",
			DoneWhen: "Dependencies and callers identified"},
		{Action: "Apply refactoring", ToolHint: "Edit",
			DoneWhen: "Changes compile cleanly", AlternativeIf: "If too many callers, consider incremental refactoring"},
		{Action: "Re-run tests to verify", ToolHint: "Bash",
			DoneWhen: "All tests pass with no regressions"},
	},
	TaskTest: {
		{Action: "Read code under test", ToolHint: "Read",
			DoneWhen: "Public API and edge cases identified"},
		{Action: "Write test cases", ToolHint: "Write",
			DoneWhen: "Tests cover happy path + error cases"},
		{Action: "Run tests", ToolHint: "Bash",
			DoneWhen: "All new tests pass"},
	},
}

// phaseToStep maps learned phase names to human-readable action descriptions.
var phaseToStep = map[string]string{
	"read":    "Read relevant files",
	"write":   "Edit/Write changes",
	"test":    "Run tests",
	"compile": "Build/Compile",
	"plan":    "Plan the approach",
}

// generatePlaybook creates a recommended workflow for the given task type.
// Uses learned workflows from past sessions if available (>=3 examples),
// otherwise falls back to hard-coded defaults.
func generatePlaybook(sdb *sessiondb.SessionDB, taskType TaskType, projectPath string) string {
	if taskType == TaskUnknown {
		return ""
	}

	key := "playbook:" + string(taskType)
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return ""
	}

	// Try learned workflow from persistent store.
	st, err := store.OpenDefault()
	if err == nil {
		defer st.Close()
		phases, count, _ := st.MostCommonWorkflow(projectPath, string(taskType), 3)
		if len(phases) > 0 {
			_ = sdb.SetCooldown(key, 30*time.Minute)
			return formatLearnedPlaybook(taskType, phases, count)
		}
	}

	// Fall back to hard-coded defaults.
	steps, ok := defaultPlaybooks[taskType]
	if !ok {
		return ""
	}

	_ = sdb.SetCooldown(key, 30*time.Minute)
	currentStep := updatePlaybookProgress(sdb, taskType)
	return formatDefaultPlaybook(taskType, steps, currentStep)
}

func formatLearnedPlaybook(taskType TaskType, phases []string, sessionCount int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[buddy] Recommended approach for %s (based on %d past sessions):", taskType, sessionCount)
	for i, phase := range phases {
		step := phaseToStep[phase]
		if step == "" {
			step = phase
		}
		fmt.Fprintf(&b, "\n  %d. %s", i+1, step)
	}
	return b.String()
}

func formatDefaultPlaybook(taskType TaskType, steps []PlaybookStep, currentStep int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[buddy] Recommended approach for %s:", taskType)
	for i, s := range steps {
		marker := " "
		if i < currentStep {
			marker = "✓"
		} else if i == currentStep {
			marker = "→"
		}
		fmt.Fprintf(&b, "\n  %s %d. %s", marker, i+1, s.Action)
		if i == currentStep && s.DoneWhen != "" {
			fmt.Fprintf(&b, "\n       Done when: %s", s.DoneWhen)
		}
		if i == currentStep && s.AlternativeIf != "" {
			fmt.Fprintf(&b, "\n       Alt: %s", s.AlternativeIf)
		}
	}
	return b.String()
}

// updatePlaybookProgress advances the playbook step based on phase transitions.
// Returns the current step index (0-based).
func updatePlaybookProgress(sdb *sessiondb.SessionDB, taskType TaskType) int {
	steps, ok := defaultPlaybooks[taskType]
	if !ok {
		return 0
	}

	progress := GetPhaseProgress(sdb)
	if progress == nil {
		return 0
	}

	// Map completed phases to playbook steps.
	completedPhases := make(map[Phase]bool)
	for _, p := range progress.CompletedPhases {
		completedPhases[p] = true
	}

	// Find the highest step whose corresponding phase is completed.
	currentStep := 0
	for i, s := range steps {
		phase := toolHintToPhase(s.ToolHint)
		if phase != PhaseUnknown && completedPhases[phase] {
			currentStep = i + 1
		}
	}
	if currentStep >= len(steps) {
		currentStep = len(steps) - 1
	}

	return currentStep
}

// toolHintToPhase maps a playbook ToolHint to a Phase.
func toolHintToPhase(hint string) Phase {
	switch {
	case strings.Contains(hint, "Read"):
		return PhaseExplore
	case strings.Contains(hint, "Edit") || strings.Contains(hint, "Write"):
		return PhaseImplement
	case strings.Contains(hint, "Bash"):
		return PhaseTest
	case strings.Contains(hint, "PlanMode"):
		return PhaseDesign
	default:
		return PhaseUnknown
	}
}
