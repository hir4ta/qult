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
	prevTool, _ := sdb.GetContext("prev_tool")
	prevPrevTool, _ := sdb.GetContext("prev_prev_tool")
	trigramMatched := false
	if prevPrevTool != "" && prevTool != "" {
		outcome, count, _ := sdb.PredictFromTrigram(prevPrevTool, prevTool, "Bash")
		if outcome == "failure" && count >= 3 {
			trigramMatched = true
			alts = append(alts, Alternative{
				Label:     "Try different approach",
				Rationale: fmt.Sprintf("The pattern %s→%s→Bash has failed %d times this session.", prevPrevTool, prevTool, count),
				Priority:  75,
			})
		}
	}
	if !trigramMatched && prevTool != "" {
		outcome, count, _ := sdb.PredictOutcome(prevTool, "Bash")
		if outcome == "failure" && count >= 5 {
			alts = append(alts, Alternative{
				Label:     "Try different approach",
				Rationale: fmt.Sprintf("The pattern %s→Bash has failed %d times this session.", prevTool, count),
				Priority:  70,
			})
		}
	}

	// 5. Next tool prediction from past successful sequences.
	if nextTool, count, _ := sdb.PredictNextTool("Bash"); nextTool != "" && count >= 3 {
		if nextTool == "Read" {
			alts = append(alts, Alternative{
				Label:     "Read after run",
				Rationale: fmt.Sprintf("In past sessions, Bash→Read was the successful pattern (%d times).", count),
				Priority:  35,
			})
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
