package main

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

// alignmentShownMarker is the HTML comment marker used to track how many times
// the alignment nudge has been shown. Persisted in session.md.
const alignmentShownMarker = "<!-- alignment-shown:"

// alignmentAckMarker is the HTML comment annotation users can add to session.md
// to suppress alignment nudges for the current task.
const alignmentAckMarker = "<!-- alignment-ack -->"

// maxAlignmentShows is the number of compactions before the nudge is fully suppressed.
// 1st: full format, 2nd: one-line summary, 3rd+: hidden.
const maxAlignmentShows = 2

// specAlignmentNudge generates a spec alignment reminder for PreCompact injection.
// Returns empty string if no spec is active, already acknowledged, or cooldown exhausted.
func specAlignmentNudge(projectPath string) string {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return ""
	}
	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return ""
	}

	// Read session.md for acknowledgment and cooldown state.
	session, _ := sd.ReadFile(spec.FileSession)
	acked := strings.Contains(session, alignmentAckMarker)
	shownCount := countAlignmentShown(session)
	workingOn := extractSection(session, "## Currently Working On")

	return specAlignmentNudgeFromState(sd, shownCount, acked, workingOn)
}

// specAlignmentNudgeFromState generates a spec alignment reminder using pre-read state.
// Called by PreCompact with state extracted from the OLD session.md (before rebuild).
// workingOn is the "Currently Working On" text from the old session.
func specAlignmentNudgeFromState(sd *spec.SpecDir, shownCount int, acked bool, workingOn string) string {
	if acked {
		debugf("specAlignmentNudge: acknowledged, skipping")
		return ""
	}
	if shownCount >= maxAlignmentShows {
		debugf("specAlignmentNudge: cooldown exhausted (%d shows), skipping", shownCount)
		return ""
	}

	// Read requirements.md for goals and success criteria.
	requirements, err := sd.ReadFile(spec.FileRequirements)
	if err != nil {
		return ""
	}

	goal := extractSection(requirements, "## Goal")
	criteria := extractSection(requirements, "## Success Criteria")
	if goal == "" && criteria == "" {
		return ""
	}

	// Extract unchecked criteria only.
	openCriteria := extractOpenCriteria(criteria)

	// Build the nudge output (workingOn is passed from caller to avoid redundant file read).
	if shownCount == 0 {
		return buildFullNudge(goal, openCriteria, workingOn)
	}
	// 2nd show: one-line summary.
	return fmt.Sprintf("Spec goals unchanged — see requirements.md for task '%s'", sd.TaskSlug)
}

// buildFullNudge constructs the full alignment nudge message.
func buildFullNudge(goal string, openCriteria []string, workingOn string) string {
	var buf strings.Builder
	buf.WriteString("Spec alignment reminder (for your awareness):\n")

	if goal != "" {
		// Truncate goal to first 200 chars for brevity.
		goalSnippet := goal
		if len([]rune(goalSnippet)) > 200 {
			goalSnippet = string([]rune(goalSnippet)[:200]) + "..."
		}
		buf.WriteString("Goal: " + goalSnippet + "\n")
	}

	if len(openCriteria) > 0 {
		buf.WriteString("Success criteria still open:\n")
		for _, c := range openCriteria {
			buf.WriteString("  " + c + "\n")
		}
	}

	if workingOn != "" {
		snippet := workingOn
		if len([]rune(snippet)) > 150 {
			snippet = string([]rune(snippet)[:150]) + "..."
		}
		buf.WriteString("Current direction: " + snippet + "\n")
	}

	buf.WriteString("The spec may need updating if your direction has changed.")
	return buf.String()
}

// extractOpenCriteria returns unchecked (- [ ]) items from the success criteria section.
func extractOpenCriteria(criteria string) []string {
	var open []string
	for line := range strings.SplitSeq(criteria, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- [ ] ") {
			open = append(open, trimmed)
		}
	}
	return open
}

// countAlignmentShown counts how many times the alignment nudge has been shown,
// based on the <!-- alignment-shown:N --> marker in session.md.
func countAlignmentShown(session string) int {
	idx := strings.LastIndex(session, alignmentShownMarker)
	if idx < 0 {
		return 0
	}
	rest := session[idx+len(alignmentShownMarker):]
	end := strings.Index(rest, " -->")
	if end < 0 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(rest[:end]))
	if err != nil {
		return 0
	}
	return n
}

// formatAlignmentShown returns a marker comment with the given count.
// The caller is responsible for computing the correct count.
func formatAlignmentShown(count int) string {
	return fmt.Sprintf("%s %d -->", alignmentShownMarker, count)
}
