package hookhandler

import "fmt"

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
