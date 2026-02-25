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
	Action   string // e.g., "Run failing test to reproduce"
	ToolHint string // e.g., "Bash(go test)"
}

// defaultPlaybooks provides hard-coded fallback workflows per task type.
var defaultPlaybooks = map[TaskType][]PlaybookStep{
	TaskBugfix: {
		{Action: "Run failing test to reproduce", ToolHint: "Bash"},
		{Action: "Read error output and trace to source", ToolHint: "Read"},
		{Action: "Edit the fix", ToolHint: "Edit"},
		{Action: "Re-run test to verify", ToolHint: "Bash"},
		{Action: "Run full test suite", ToolHint: "Bash"},
	},
	TaskFeature: {
		{Action: "Plan the approach", ToolHint: "EnterPlanMode"},
		{Action: "Read existing related code", ToolHint: "Read"},
		{Action: "Implement the feature", ToolHint: "Edit/Write"},
		{Action: "Add tests", ToolHint: "Write"},
		{Action: "Run tests", ToolHint: "Bash"},
	},
	TaskRefactor: {
		{Action: "Run tests to establish baseline", ToolHint: "Bash"},
		{Action: "Read target code", ToolHint: "Read"},
		{Action: "Apply refactoring", ToolHint: "Edit"},
		{Action: "Re-run tests to verify", ToolHint: "Bash"},
	},
	TaskTest: {
		{Action: "Read code under test", ToolHint: "Read"},
		{Action: "Write test cases", ToolHint: "Write"},
		{Action: "Run tests", ToolHint: "Bash"},
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
	return formatDefaultPlaybook(taskType, steps)
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

func formatDefaultPlaybook(taskType TaskType, steps []PlaybookStep) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[buddy] Recommended approach for %s:", taskType)
	for i, s := range steps {
		fmt.Fprintf(&b, "\n  %d. %s", i+1, s.Action)
	}
	return b.String()
}
