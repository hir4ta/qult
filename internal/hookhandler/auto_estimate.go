package hookhandler

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// autoEstimate returns a compact 1-line task estimate from historical data.
// Returns "" if insufficient data (fewer than 3 sessions for this task type).
func autoEstimate(cwd, taskType string) string {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

	workflows, err := st.GetSuccessfulWorkflows(cwd, taskType, 50)
	if err != nil || len(workflows) < 3 {
		return ""
	}

	// Collect tool counts and compute median.
	toolCounts := make([]int, 0, len(workflows))
	for _, w := range workflows {
		toolCounts = append(toolCounts, w.ToolCount)
	}
	sort.Ints(toolCounts)

	median := toolCounts[len(toolCounts)/2]

	// Compute success rate from all workflows (including failures).
	allWorkflows, _ := st.GetWorkflows(cwd, taskType, 100)
	successes := 0
	for _, w := range allWorkflows {
		if w.Success {
			successes++
		}
	}
	var rate float64
	if len(allWorkflows) > 0 {
		rate = float64(successes) / float64(len(allWorkflows))
	}

	// Build compact output.
	var b strings.Builder
	fmt.Fprintf(&b, "~%d tools, %.0f%% success", median, rate*100)

	// Append common workflow phases if available.
	phases, _, _ := st.MostCommonWorkflow(cwd, taskType, 3)
	if len(phases) > 0 {
		b.WriteString(" | ")
		b.WriteString(strings.Join(phases, "→"))
	}

	return b.String()
}

// autoNextStep returns the single highest-priority next action based on
// session state. Covers unresolved failures, build errors, pending tests,
// and test failures (rules 1-4 from the full next-step engine).
func autoNextStep(sdb *sessiondb.SessionDB) string {
	// Rule 1: unresolved failures.
	failures, _ := sdb.RecentFailures(3)
	for _, f := range failures {
		if f.FilePath == "" {
			continue
		}
		unresolved, failType, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if !unresolved {
			continue
		}
		base := filepath.Base(f.FilePath)
		return fmt.Sprintf("Fix %s in %s", failType, base)
	}

	// Rule 2: build failed.
	if lastBuild, _ := sdb.GetContext("last_build_passed"); lastBuild == "false" {
		return "Fix compilation errors — last build failed"
	}

	// Rule 3: code changed but tests not run.
	if hasWrite, _ := sdb.GetContext("burst_has_write"); hasWrite == "true" {
		if hasTest, _ := sdb.GetContext("has_test_run"); hasTest != "true" {
			return "Run tests — code changed but not yet tested"
		}
	}

	// Rule 4: tests ran but failed.
	if testPassed, _ := sdb.GetContext("last_test_passed"); testPassed == "false" {
		return "Fix failing tests before continuing"
	}

	return ""
}
