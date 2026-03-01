package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

type notificationInput struct {
	CommonInput
	NotificationType string `json:"notification_type,omitempty"`
	Message          string `json:"message,omitempty"`
}

// handleNotification dequeues nudges during idle notifications and generates
// phase-aware next step suggestions when no nudges are pending.
func handleNotification(input []byte) (*HookOutput, error) {
	var in notificationInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[alfred] Notification: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// Dequeue up to 2 nudges during idle time.
	nudges, _ := sdb.DequeueNudges(2)

	// Nudge delivery tracking removed (alfred v1 simplification).

	var parts []string
	for _, n := range nudges {
		parts = append(parts, fmt.Sprintf("[alfred] %s (%s): %s\n→ %s",
			n.Pattern, n.Level, n.Observation, n.Suggestion))
	}

	// When no pending nudges, generate a phase-aware next step suggestion.
	if len(nudges) == 0 {
		if nextStep := generateIdleNextStep(sdb); nextStep != "" {
			parts = append(parts, nextStep)
		}
	}

	if len(parts) == 0 {
		return nil, nil
	}

	return makeOutput("Notification", strings.Join(parts, "\n")), nil
}

// generateIdleNextStep produces a context-aware next step suggestion
// based on the current task type, workflow phase, and session state.
func generateIdleNextStep(sdb *sessiondb.SessionDB) string {
	on, _ := sdb.IsOnCooldown("idle_next_step")
	if on {
		return ""
	}

	progress := GetPhaseProgress(sdb)
	intent, _ := sdb.GetWorkingSet("intent")

	// Need at least some context to make a useful suggestion.
	if progress == nil && intent == "" {
		return ""
	}

	var suggestion string

	// Priority 1: Surface unresolved failures with past solutions.
	if hint := unresolvedFailureHint(sdb); hint != "" {
		suggestion = hint
	}

	// Priority 2: Phase-aware next step.
	if suggestion == "" && progress != nil {
		suggestion = phaseAwareNextStep(progress, sdb)
	}

	if suggestion == "" {
		return ""
	}

	_ = sdb.SetCooldown("idle_next_step", 5*time.Minute)

	var b strings.Builder
	b.WriteString("[alfred] next-step (info): Session idle — suggested next action")
	b.WriteString("\n→ ")
	b.WriteString(suggestion)
	return b.String()
}

// phaseAwareNextStep generates a suggestion based on current phase progress.
func phaseAwareNextStep(progress *PhaseProgress, sdb *sessiondb.SessionDB) string {
	// Suggest based on expected next phase.
	if progress.ExpectedPhase != PhaseUnknown && progress.ExpectedPhase != progress.CurrentPhase {
		return nextStepForPhase(progress.ExpectedPhase, progress.TaskType, sdb)
	}

	// If no clear next phase, suggest based on current phase completion.
	return nextStepForPhase(progress.CurrentPhase, progress.TaskType, sdb)
}

// nextStepForPhase returns a concrete suggestion for the given phase.
func nextStepForPhase(phase Phase, _ TaskType, sdb *sessiondb.SessionDB) string {
	hasTestRun, _ := sdb.GetContext("has_test_run")
	lastTestPassed, _ := sdb.GetContext("last_test_passed")
	files, _ := sdb.GetWorkingSetFiles()

	switch phase {
	case PhaseExplore:
		if len(files) > 0 {
			return "Exploration phase: Read related files and understand the current code before making changes."
		}
		return "Start by reading the relevant source files to understand the current implementation."

	case PhaseReproduce:
		return "Reproduce the issue: run the failing test or trigger the bug to confirm the problem."

	case PhaseDiagnose:
		return "Diagnose the root cause: add debug output or trace the execution path."

	case PhaseDesign:
		return "Design phase: consider using Plan Mode to outline the approach before implementing."

	case PhasePlan:
		return "Plan the implementation: identify which files need changes and in what order."

	case PhaseImplement:
		if lastTestPassed == "false" {
			return "Tests are currently failing. Fix the failing tests before adding new changes."
		}
		return "Implement the changes. Focus on one file at a time."

	case PhaseTest:
		if hasTestRun != "true" && len(files) > 0 {
			return fmt.Sprintf("Run tests to verify your changes (%d file(s) modified).", len(files))
		}
		return "Write or update tests for the new functionality."

	case PhaseVerify:
		if hasTestRun != "true" {
			return "Verify: run the full test suite to confirm nothing is broken."
		}
		if lastTestPassed == "false" {
			return "Tests are failing. Review the output and fix the issues."
		}
		return "Tests passing. Consider running the build and doing a final review before committing."

	case PhaseRefine:
		return "Refine: review the changes for edge cases, error handling, and code quality."
	}

	return ""
}

// unresolvedFailureHint checks for recent unresolved failures and searches
// past solutions to provide concrete fix suggestions during idle time.
func unresolvedFailureHint(sdb *sessiondb.SessionDB) string {
	on, _ := sdb.IsOnCooldown("idle_failure_hint")
	if on {
		return ""
	}

	failures, _ := sdb.RecentFailures(3)
	if len(failures) == 0 {
		return ""
	}

	// Find the most recent unresolved failure.
	for _, f := range failures {
		if f.FilePath == "" {
			continue
		}
		unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if !unresolved {
			continue
		}

		_ = sdb.SetCooldown("idle_failure_hint", 10*time.Minute)

		return fmt.Sprintf("Unresolved %s in %s — consider fixing before continuing.", f.FailureType, f.FilePath)
	}

	return ""
}
