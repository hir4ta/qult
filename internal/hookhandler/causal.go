package hookhandler

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"github.com/hir4ta/claude-buddy/internal/store"
)

// formatCausalChain formats a causal reasoning chain for briefing output.
// Format: "cause → effect\n  WHY: evidence\n  → action"
func formatCausalChain(cause, effect, evidence, action string) string {
	msg := cause + " → " + effect
	if evidence != "" {
		msg += "\n  WHY: " + evidence
	}
	if action != "" {
		msg += "\n  → " + action
	}
	return msg
}

// formatCausalChainWithHistory adds past incident references to causal chains.
// If a matching past failure solution exists for the given file, it appends a
// "PAST:" line with resolution details. Falls back to the base chain on any error.
func formatCausalChainWithHistory(cause, effect, evidence, action, filePath string) string {
	base := formatCausalChain(cause, effect, evidence, action)
	if filePath == "" {
		return base
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return base
	}

	solutions, err := st.SearchFailureSolutionsByFile(filePath, 1)
	if err != nil || len(solutions) == 0 {
		return base
	}

	sol := solutions[0]
	return base + "\n  " + formatIncidentRef(sol)
}

// formatIncidentRef produces a compact "PAST:" reference from a FailureSolution.
// Includes the failure type, age, and resolution diff when available.
func formatIncidentRef(sol store.FailureSolution) string {
	var label string
	if sol.FailureType != "" {
		label = sol.FailureType
	} else {
		label = filepath.Base(sol.FilePath)
	}

	age := formatAge(sol.Timestamp)
	ref := fmt.Sprintf("PAST: %s resolved %s", label, age)

	if sol.ResolutionDiff != "" {
		if diffStr := summarizeResolutionDiff(sol.ResolutionDiff); diffStr != "" {
			ref += " (" + diffStr + ")"
		}
	}

	if sol.TimesEffective > 0 {
		ref += fmt.Sprintf(" [effective %d/%d]", sol.TimesEffective, sol.TimesSurfaced)
	}

	return ref
}

// summarizeResolutionDiff parses a JSON resolution diff and returns a compact "old→new" string.
func summarizeResolutionDiff(raw string) string {
	var diff struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if json.Unmarshal([]byte(raw), &diff) != nil || diff.Old == "" {
		return ""
	}
	old := truncate(diff.Old, 40)
	new_ := truncate(diff.New, 40)
	return "`" + old + "` → `" + new_ + "`"
}

// formatAge returns a human-readable age string relative to now.
func formatAge(t time.Time) string {
	if t.IsZero() {
		return "previously"
	}
	d := time.Since(t)
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// formatPersonalWhy enriches a WHY string with personal data.
// Returns the base string unchanged when PersonalStats has insufficient data.
func formatPersonalWhy(base string, ps *PersonalStats, pattern string) string {
	if ps == nil || ps.SessionCount < 3 {
		return base
	}

	suffix := personalSuffix(ps, pattern)
	if suffix == "" {
		return base
	}

	if base == "" {
		return suffix
	}
	return base + ". " + suffix
}

// personalSuffix generates a data-backed personal context suffix.
func personalSuffix(ps *PersonalStats, pattern string) string {
	switch {
	case ps.SuccessMedianTools > 0 && ps.CurrentPace > 1.5:
		return fmt.Sprintf("Your successful sessions avg %d tools — current pace is %.0f%% above that",
			ps.SuccessMedianTools, (ps.CurrentPace-1)*100)
	case ps.SuccessMedianTools > 0:
		return fmt.Sprintf("Your successful sessions avg %d tools (%d sessions)",
			ps.SuccessMedianTools, ps.SessionCount)
	case ps.TestFrequency < 0.2 && ps.SessionCount >= 5:
		return fmt.Sprintf("Test frequency %.0f%% — lower than recommended", ps.TestFrequency*100)
	default:
		return ""
	}
}
