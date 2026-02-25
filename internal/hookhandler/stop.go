package hookhandler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type stopInput struct {
	CommonInput
	StopHookActive       bool   `json:"stop_hook_active"`
	LastAssistantMessage string `json:"last_assistant_message"`
}

func handleStop(input []byte) (*HookOutput, error) {
	var in stopInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// Prevent infinite loops: if stop_hook_active, allow stop immediately.
	if in.StopHookActive {
		return nil, nil
	}

	// Session-aware pre-check: skip completeness checks if no code was modified.
	hasCodeChanges := false
	if in.SessionID != "" {
		if sdb, err := sessiondb.Open(in.SessionID); err == nil {
			files, _ := sdb.GetWorkingSetFiles()
			hasCodeChanges = len(files) > 0
			sdb.Close()
		}
	}

	var issues []string

	// Always check for explicit TODO/FIXME markers and incomplete work in assistant message.
	// These indicate unfinished intent regardless of whether code was modified.
	issues = checkCompleteness(in.LastAssistantMessage, hasCodeChanges)

	// Session-aware checks using sessiondb.
	issues = append(issues, checkSessionIssues(in.SessionID)...)

	if len(issues) > 0 {
		return makeBlockStopOutput(strings.Join(issues, "; ")), nil
	}

	// Uncommitted changes are informational only — log to stderr, don't block.
	if gitInfo := checkUncommittedChanges(in.SessionID, in.CWD); gitInfo != "" {
		fmt.Fprintf(os.Stderr, "[buddy] %s\n", gitInfo)
	}

	return nil, nil
}

// checkCompleteness scans assistant message for signs of incomplete work.
// TODO/FIXME markers and incomplete-work phrases are always checked.
// Test/build failure reports are only checked when hasCodeChanges is true,
// to avoid false positives on explanatory text about detection features.
func checkCompleteness(msg string, hasCodeChanges bool) []string {
	if msg == "" {
		return nil
	}

	lower := strings.ToLower(msg)
	var issues []string

	// TODO/FIXME markers — require colon to avoid matching the word in descriptions.
	for _, p := range []string{"todo:", "fixme:", "hack:", "xxx:"} {
		if strings.Contains(lower, p) {
			// Exclude cases where TODO/FIXME is part of a feature description.
			surrounding := extractSurrounding(lower, p, 30)
			if containsAnyWord(surrounding, []string{
				"detect", "check", "pattern", "heuristic", "検出", "チェック",
			}) {
				continue
			}
			issues = append(issues, "TODO/FIXME marker found in last response")
			break
		}
	}

	// Explicit incomplete work.
	for _, p := range []string{
		"i'll finish", "i'll complete", "remaining work",
		"not yet implemented", "placeholder",
		"まだ完了していません", "残りの作業",
	} {
		if strings.Contains(lower, p) {
			// Exclude feature descriptions.
			surrounding := extractSurrounding(lower, p, 30)
			if containsAnyWord(surrounding, []string{
				"detect", "check", "pattern", "heuristic", "検出", "チェック",
				"gate", "ゲート", "pipeline",
			}) {
				continue
			}
			issues = append(issues, "Incomplete work mentioned in last response")
			break
		}
	}

	// Test and build failure checks only when code was actually modified,
	// to avoid false positives on messages describing detection features.
	if hasCodeChanges {
		if containsFailureReport(lower, []string{
			"test fail", "tests fail", "test failed", "tests failed", "failing test",
			"テストが失敗", "テスト失敗",
		}, []string{
			"予測", "チェック", "検出", "detect", "prediction", "check for", "heuristic",
			"パターン", "pattern", "ゲート", "gate", "pipeline",
		}) {
			issues = append(issues, "Unresolved test failure mentioned in last response")
		}

		if containsFailureReport(lower, []string{
			"build failed", "compilation error", "compile error", "does not compile",
			"ビルド失敗", "コンパイルエラー",
		}, []string{
			"予測", "チェック", "検出", "detect", "prediction", "check for", "heuristic",
			"パターン", "pattern", "ゲート", "gate", "pipeline",
		}) {
			issues = append(issues, "Unresolved build failure mentioned in last response")
		}
	}

	return issues
}

// extractSurrounding returns up to radius characters around the first occurrence of pattern.
func extractSurrounding(text, pattern string, radius int) string {
	idx := strings.Index(text, pattern)
	if idx < 0 {
		return ""
	}
	runes := []rune(text)
	runeIdx := len([]rune(text[:idx]))
	start := max(0, runeIdx-radius)
	end := min(len(runes), runeIdx+len([]rune(pattern))+radius)
	return string(runes[start:end])
}

// containsAnyWord checks if text contains any of the given words.
func containsAnyWord(text string, words []string) bool {
	for _, w := range words {
		if strings.Contains(text, w) {
			return true
		}
	}
	return false
}

// containsFailureReport checks if text contains a failure keyword but filters out
// compound words that describe functionality (e.g., "テスト失敗予測") rather than
// actual failure reports.
func containsFailureReport(text string, patterns, exclusions []string) bool {
	runes := []rune(text)
	for _, p := range patterns {
		pRunes := []rune(p)
		// Search all occurrences, not just the first.
		searchText := text
		byteOffset := 0
		for {
			idx := strings.Index(searchText, p)
			if idx < 0 {
				break
			}
			// Convert byte offset to rune offset for safe slicing.
			runeIdx := len([]rune(text[:byteOffset+idx]))
			start := max(0, runeIdx-15)
			end := min(len(runes), runeIdx+len(pRunes)+15)
			surrounding := string(runes[start:end])
			excluded := false
			for _, ex := range exclusions {
				if strings.Contains(surrounding, ex) {
					excluded = true
					break
				}
			}
			if !excluded {
				return true
			}
			// Advance past this occurrence.
			byteOffset += idx + len(p)
			searchText = text[byteOffset:]
		}
	}
	return false
}

// checkSessionIssues uses the session database to detect unresolved failures
// and untested code modifications.
func checkSessionIssues(sessionID string) []string {
	if sessionID == "" {
		return nil
	}

	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		return nil
	}
	defer sdb.Close()

	// Skip checks if working_set has no files (no code changes in this session).
	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 {
		return nil
	}

	var issues []string

	// Check for unresolved failures (recent failure with no subsequent fix).
	failures, _ := sdb.RecentFailures(3)
	for _, f := range failures {
		if time.Since(f.Timestamp) > 10*time.Minute {
			continue
		}
		if f.FilePath == "" {
			continue
		}
		unresolved, failType, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if unresolved && failType != "generic" {
			issues = append(issues, fmt.Sprintf("Unresolved %s in %s", failType, filepath.Base(f.FilePath)))
			break // report only the most recent
		}
	}

	// Check if tests were run when code was modified.
	taskType, _ := sdb.GetWorkingSet("task_type")
	if taskType == "bugfix" || taskType == "feature" || taskType == "refactor" {
		hasTestRun, _ := sdb.GetContext("has_test_run")
		if hasTestRun != "true" {
			issues = append(issues, "Code was modified but tests were not run in this session")
		}
	}

	return issues
}

// checkUncommittedChanges checks if there are uncommitted git changes when stopping.
// Returns an informational message, or "" if clean or not in a git repo.
func checkUncommittedChanges(sessionID, cwd string) string {
	if cwd == "" {
		// Try to get CWD from session DB.
		sdb, err := sessiondb.Open(sessionID)
		if err != nil {
			return ""
		}
		defer sdb.Close()
		cwd, _ = sdb.GetContext("cwd")
		if cwd == "" {
			return ""
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	status, err := execGit(ctx, cwd, "status", "--porcelain")
	if err != nil || strings.TrimSpace(status) == "" {
		return ""
	}

	lines := strings.Split(strings.TrimSpace(status), "\n")
	return fmt.Sprintf("%d uncommitted file(s) in working directory", len(lines))
}
