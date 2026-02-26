package hookhandler

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// Alternative represents a suggested approach with evidence.
type Alternative struct {
	Label     string // e.g., "Read first", "Use past solution"
	Rationale string // Why this alternative is suggested
	Priority  int    // Higher = more relevant, used for ordering
}

// presentAlternatives builds structured alternatives for a PreToolUse action.
// Returns a formatted string with numbered options, or "" if no alternatives.
func presentAlternatives(sdb *sessiondb.SessionDB, toolName string, toolInput json.RawMessage) string {
	switch toolName {
	case "Edit", "Write":
		return editAlternatives(sdb, toolInput)
	case "Bash":
		return bashAlternatives(sdb, toolInput)
	default:
		return ""
	}
}

// editAlternatives generates alternatives before Edit/Write operations.
func editAlternatives(sdb *sessiondb.SessionDB, toolInput json.RawMessage) string {
	var ei struct {
		FilePath string `json:"file_path"`
	}
	if json.Unmarshal(toolInput, &ei) != nil || ei.FilePath == "" {
		return ""
	}

	key := "alternatives:" + filepath.Base(ei.FilePath)
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return ""
	}

	var alts []Alternative

	// 1. Failure rate check — recommend Read first if high failure rate.
	prob, total, _ := sdb.FailureProbability("Edit", ei.FilePath)
	if total >= 3 && prob > 0.3 {
		alts = append(alts, Alternative{
			Label:     "Read first (recommended)",
			Rationale: fmt.Sprintf("%.0f%% edit failure rate (%d attempts). Re-read to get exact content.", prob*100, total),
			Priority:  90,
		})
	}

	// 2. Stale read check — recommend Read if file hasn't been read recently.
	lastSeq, _ := sdb.FileLastReadSeq(ei.FilePath)
	currentSeq, _ := sdb.CurrentEventSeq()
	if lastSeq == 0 {
		alts = append(alts, Alternative{
			Label:     "Read first (recommended)",
			Rationale: "This file has not been Read in this session.",
			Priority:  85,
		})
	} else if currentSeq-lastSeq >= 8 {
		alts = append(alts, Alternative{
			Label:     "Re-read file",
			Rationale: fmt.Sprintf("Last Read was %d tool calls ago — content may have changed.", currentSeq-lastSeq),
			Priority:  80,
		})
	}

	// 3. Past failure solutions for this file.
	st, err := store.OpenDefault()
	if err == nil {
		defer st.Close()

		solutions, _ := st.SearchFailureSolutionsByFile(ei.FilePath, 2)
		for _, sol := range solutions {
			text := sol.SolutionText
			if len([]rune(text)) > 100 {
				text = string([]rune(text)[:100]) + "..."
			}
			alts = append(alts, Alternative{
				Label:     "Past fix available",
				Rationale: text,
				Priority:  70,
			})
		}

		// 4. Past architectural decisions for this file.
		decisions, _ := st.SearchDecisionsByFile(ei.FilePath, 2)
		for _, d := range decisions {
			text := d.DecisionText
			if len([]rune(text)) > 100 {
				text = string([]rune(text)[:100]) + "..."
			}
			alts = append(alts, Alternative{
				Label:     "Past decision",
				Rationale: text,
				Priority:  60,
			})
		}

		// 5. Past architecture patterns for this file.
		patterns, _ := st.SearchPatternsByFile(ei.FilePath, 1)
		for _, p := range patterns {
			if p.PatternType == "architecture" {
				text := p.Content
				if len([]rune(text)) > 100 {
					text = string([]rune(text)[:100]) + "..."
				}
				alts = append(alts, Alternative{
					Label:     "Architecture note",
					Rationale: text,
					Priority:  50,
				})
			}
		}

		// 5b. Cross-session failure history for this file.
		_, totalCross, _ := st.FailureHistoryForFile(ei.FilePath, 2)
		if totalCross >= 3 {
			alts = append(alts, Alternative{
				Label:     "Cross-session failures",
				Rationale: fmt.Sprintf("This file has had %d failures across sessions.", totalCross),
				Priority:  75,
			})
		}

		// 5c. Directory-level architecture patterns.
		dirPath := filepath.Dir(ei.FilePath)
		dirPatterns, _ := st.SearchPatternsByDirectory(dirPath, "architecture", 1)
		for _, p := range dirPatterns {
			text := p.Content
			if len([]rune(text)) > 100 {
				text = string([]rune(text)[:100]) + "..."
			}
			alts = append(alts, Alternative{
				Label:     "Package architecture",
				Rationale: text,
				Priority:  45,
			})
		}

		// 5d. Directory-level decisions.
		dirDecisions, _ := st.SearchDecisionsByDirectory(dirPath, 1)
		for _, d := range dirDecisions {
			text := d.DecisionText
			if len([]rune(text)) > 100 {
				text = string([]rune(text)[:100]) + "..."
			}
			alts = append(alts, Alternative{
				Label:     "Package decision",
				Rationale: text,
				Priority:  42,
			})
		}
	}

	// 6. File hotspot — edited too many times this session.
	files, _ := sdb.GetWorkingSetFiles()
	editCount := 0
	for _, f := range files {
		if f == ei.FilePath {
			editCount++
		}
	}
	if editCount >= 3 {
		alts = append(alts, Alternative{
			Label:     "Step back and re-read",
			Rationale: fmt.Sprintf("This file has been modified %d times this session.", editCount),
			Priority:  40,
		})
	}

	// 7. Intent-aware: editing without tests for bugfix/refactor tasks.
	taskType, _ := sdb.GetContext("task_type")
	hasTestRun, _ := sdb.GetContext("has_test_run")
	if (taskType == "bugfix" || taskType == "refactor") && hasTestRun != "true" {
		_, hasWrite, _, _ := sdb.BurstState()
		if hasWrite {
			alts = append(alts, Alternative{
				Label:     "Run tests first",
				Rationale: fmt.Sprintf("Multiple edits for %s task without running tests.", taskType),
				Priority:  55,
			})
		}
	}

	// 8. Pre-existing git changes.
	dirtyFiles, _ := sdb.GetWorkingSet("git_dirty_files")
	if dirtyFiles != "" {
		target := ei.FilePath
		for _, dirty := range strings.Split(dirtyFiles, "\n") {
			if dirty == "" {
				continue
			}
			if strings.HasSuffix(target, dirty) || filepath.Base(target) == filepath.Base(dirty) {
				branch, _ := sdb.GetWorkingSet("git_branch")
				rationale := fmt.Sprintf("%s had uncommitted changes at session start.", filepath.Base(ei.FilePath))
				if branch != "" {
					rationale += fmt.Sprintf(" (branch: %s)", branch)
				}
				alts = append(alts, Alternative{
					Label:     "Commit/stash first",
					Rationale: rationale,
					Priority:  45,
				})
				break
			}
		}
	}

	return formatAlternatives(sdb, key, ei.FilePath, alts)
}

// bashAlternatives generates alternatives before Bash operations.
func bashAlternatives(sdb *sessiondb.SessionDB, toolInput json.RawMessage) string {
	var bi struct {
		Command string `json:"command"`
	}
	if json.Unmarshal(toolInput, &bi) != nil || bi.Command == "" {
		return ""
	}

	key := "alternatives:bash:" + extractCmdSignature(bi.Command)
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return ""
	}

	var alts []Alternative

	// 1. Unresolved failures — suggest fixing first.
	failures, _ := sdb.RecentFailures(3)
	for _, f := range failures {
		if f.FilePath == "" || time.Since(f.Timestamp) > 10*time.Minute {
			continue
		}
		unresolved, failType, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if unresolved {
			alts = append(alts, Alternative{
				Label:     "Fix first",
				Rationale: fmt.Sprintf("Unresolved %s in %s — fix before re-running.", failType, filepath.Base(f.FilePath)),
				Priority:  85,
			})
			break
		}
	}

	// 2. Past failure for similar command.
	sig := extractCmdSignature(bi.Command)
	if sig != "" {
		summary, _ := sdb.FindSimilarFailure(sig)
		if summary != "" {
			if len([]rune(summary)) > 80 {
				summary = string([]rune(summary)[:80]) + "..."
			}
			alts = append(alts, Alternative{
				Label:     "Similar command failed",
				Rationale: summary,
				Priority:  75,
			})
		}
	}

	// 3. Compile prediction — last compile failed, file not edited.
	if isCompileCommand(bi.Command) {
		recentFail, _ := sdb.RecentFailures(1)
		if len(recentFail) > 0 {
			f := recentFail[0]
			if f.FailureType == "compile_error" && time.Since(f.Timestamp) < 5*time.Minute && f.FilePath != "" {
				unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath)
				if unresolved {
					alts = append(alts, Alternative{
						Label:     "Edit file first",
						Rationale: fmt.Sprintf("Last compile failed in %s and it hasn't been edited yet.", filepath.Base(f.FilePath)),
						Priority:  90,
					})
				}
			}
		}
	}

	// 4. Tool sequence prediction (trigram preferred, bigram fallback).
	// Combines session-local (2x weight) + global data for better prediction.
	prevTool, _ := sdb.GetContext("prev_tool")
	prevPrevTool, _ := sdb.GetContext("prev_prev_tool")
	trigramMatched := false
	if prevPrevTool != "" && prevTool != "" {
		outcome, count, _ := sdb.PredictFromTrigram(prevPrevTool, prevTool, "Bash")
		// Also check global trigrams.
		globalCount := 0
		if st, stErr := store.OpenDefault(); stErr == nil {
			preds, _ := st.PredictFromTrigramGlobal(prevPrevTool, prevTool, 1)
			st.Close()
			for _, p := range preds {
				if p.Tool == "Bash" && p.SuccessRate < 0.3 {
					globalCount = p.Count
				}
			}
		}
		combinedCount := count*2 + globalCount // session-local weighted 2x
		if outcome == "failure" && combinedCount >= 3 {
			trigramMatched = true
			alts = append(alts, Alternative{
				Label:     "Try different approach",
				Rationale: fmt.Sprintf("The pattern %s→%s→Bash has failed %d times (session: %d, global: %d).", prevPrevTool, prevTool, combinedCount, count, globalCount),
				Priority:  75,
			})
		}
	}
	if !trigramMatched && prevTool != "" {
		outcome, count, _ := sdb.PredictOutcome(prevTool, "Bash")
		globalCount := 0
		if st, stErr := store.OpenDefault(); stErr == nil {
			preds, _ := st.PredictNextToolGlobal(prevTool, 3)
			st.Close()
			for _, p := range preds {
				if p.Tool == "Bash" && p.SuccessRate < 0.3 {
					globalCount = p.Count
				}
			}
		}
		combinedCount := count*2 + globalCount
		if outcome == "failure" && combinedCount >= 5 {
			alts = append(alts, Alternative{
				Label:     "Try different approach",
				Rationale: fmt.Sprintf("The pattern %s→Bash has failed %d times (session: %d, global: %d).", prevTool, combinedCount, count, globalCount),
				Priority:  70,
			})
		}
	}

	// 5. Next tool prediction from combined session + global sequences.
	if nextTool, count, _ := sdb.PredictNextTool("Bash"); nextTool != "" && count >= 3 {
		if nextTool == "Read" {
			alts = append(alts, Alternative{
				Label:     "Read after run",
				Rationale: fmt.Sprintf("In past sessions, Bash→Read was the successful pattern (%d times).", count),
				Priority:  35,
			})
		}
	} else if st, stErr := store.OpenDefault(); stErr == nil {
		preds, _ := st.PredictNextToolGlobal("Bash", 1)
		st.Close()
		for _, p := range preds {
			if p.Tool == "Read" && p.Count >= 5 && p.SuccessRate > 0.5 {
				alts = append(alts, Alternative{
					Label:     "Read after run",
					Rationale: fmt.Sprintf("Across sessions, Bash→Read was successful %d times (%.0f%% success).", p.Count, p.SuccessRate*100),
					Priority:  35,
				})
			}
		}
	}

	// 6. Workflow deviation warning.
	taskType, _ := sdb.GetContext("task_type")
	if taskType != "" {
		currentPhase := classifyBashPhase(bi.Command)
		if currentPhase != "" {
			st, stErr := store.OpenDefault()
			if stErr == nil {
				defer st.Close()
				expectedPhases, wfCount, _ := st.MostCommonWorkflow("", taskType, 3)
				if len(expectedPhases) > 0 && wfCount >= 3 {
					recentPhases := getRecentPhases(sdb, 5)
					nextExpected := findNextExpectedPhase(recentPhases, expectedPhases)
					if nextExpected != "" && nextExpected != currentPhase {
						alts = append(alts, Alternative{
							Label:     "Workflow deviation",
							Rationale: fmt.Sprintf("For %s tasks, next step is usually '%s' (%d sessions). Currently doing '%s'.", taskType, nextExpected, wfCount, currentPhase),
							Priority:  40,
						})
					}
				}
			}
		}
	}

	return formatAlternatives(sdb, key, bi.Command, alts)
}

// formatAlternatives formats alternatives into a structured output string.
// Returns "" and does not set cooldown if no alternatives.
func formatAlternatives(sdb *sessiondb.SessionDB, cooldownKey, target string, alts []Alternative) string {
	if len(alts) == 0 {
		return ""
	}

	_ = sdb.SetCooldown(cooldownKey, 5*time.Minute)

	// Deduplicate by label (keep highest priority).
	seen := make(map[string]bool)
	var deduped []Alternative
	for _, a := range alts {
		if seen[a.Label] {
			continue
		}
		seen[a.Label] = true
		deduped = append(deduped, a)
	}

	// Sort by priority descending.
	for i := 0; i < len(deduped); i++ {
		for j := i + 1; j < len(deduped); j++ {
			if deduped[j].Priority > deduped[i].Priority {
				deduped[i], deduped[j] = deduped[j], deduped[i]
			}
		}
	}

	// Cap at 3 alternatives.
	if len(deduped) > 3 {
		deduped = deduped[:3]
	}

	// Format output.
	displayTarget := target
	if len(displayTarget) > 60 {
		displayTarget = filepath.Base(target)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "[buddy] Before this action on %s, consider:", displayTarget)
	for i, a := range deduped {
		fmt.Fprintf(&b, "\n  %d. %s — %s", i+1, a.Label, a.Rationale)
	}
	return b.String()
}

// classifyBashPhase maps a bash command to a workflow phase name.
func classifyBashPhase(command string) string {
	cmd := strings.ToLower(command)
	switch {
	case strings.Contains(cmd, "test") || strings.Contains(cmd, "pytest") || strings.Contains(cmd, "jest"):
		return "test"
	case strings.Contains(cmd, "build") || strings.Contains(cmd, "compile") || strings.Contains(cmd, "tsc"):
		return "build"
	case strings.Contains(cmd, "run") || strings.Contains(cmd, "exec"):
		return "run"
	case strings.Contains(cmd, "lint") || strings.Contains(cmd, "vet") || strings.Contains(cmd, "check"):
		return "lint"
	default:
		return ""
	}
}

// getRecentPhases returns the last N phase names from sessiondb session_phases.
func getRecentPhases(sdb *sessiondb.SessionDB, n int) []string {
	phases, _ := sdb.GetRawPhaseSequence(n)
	return phases
}

// findNextExpectedPhase finds the expected next phase given current progress.
// Walks expectedWorkflow, finds the furthest matching phase from recentPhases,
// and returns the next phase in the expected sequence.
func findNextExpectedPhase(recentPhases, expectedWorkflow []string) string {
	if len(expectedWorkflow) == 0 {
		return ""
	}

	// Find the furthest phase in expectedWorkflow that appears in recentPhases.
	furthestIdx := -1
	for _, recent := range recentPhases {
		for i, expected := range expectedWorkflow {
			if recent == expected && i > furthestIdx {
				furthestIdx = i
			}
		}
	}

	// Return the next phase after the furthest match.
	if furthestIdx >= 0 && furthestIdx+1 < len(expectedWorkflow) {
		return expectedWorkflow[furthestIdx+1]
	}

	// No match found — suggest the first phase.
	if furthestIdx < 0 && len(expectedWorkflow) > 0 {
		return expectedWorkflow[0]
	}
	return ""
}
