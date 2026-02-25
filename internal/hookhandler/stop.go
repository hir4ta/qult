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

	issues := checkCompleteness(in.LastAssistantMessage)

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
// Only checks for high-signal deterministic patterns. Error detection is
// left to the LLM prompt hook to avoid false positives on explanatory text.
func checkCompleteness(msg string) []string {
	if msg == "" {
		return nil
	}

	lower := strings.ToLower(msg)
	var issues []string

	// TODO/FIXME markers.
	for _, p := range []string{"todo:", "fixme:", "hack:", "xxx:"} {
		if strings.Contains(lower, p) {
			issues = append(issues, "TODO/FIXME marker found in last response")
			break
		}
	}

	// Explicit incomplete work.
	for _, p := range []string{
		"i'll finish", "i'll complete", "remaining work",
		"not yet implemented", "placeholder",
		"まだ完了していません", "残りの作業", "未実装",
	} {
		if strings.Contains(lower, p) {
			issues = append(issues, "Incomplete work mentioned in last response")
			break
		}
	}

	// Test failures mentioned without resolution.
	// Exclude compound words like "テスト失敗予測" (test failure prediction) and
	// feature descriptions like "テスト未実行チェック" that describe functionality.
	if containsFailureReport(lower, []string{
		"test fail", "tests fail", "test failed", "tests failed", "failing test",
		"テストが失敗", "テスト失敗",
	}, []string{
		"予測", "チェック", "検出", "detect", "prediction", "check for", "heuristic",
		"パターン", "pattern", "ゲート", "gate", "pipeline",
	}) {
		issues = append(issues, "Unresolved test failure mentioned in last response")
	}

	// Build failures mentioned without resolution.
	if containsFailureReport(lower, []string{
		"build failed", "compilation error", "compile error", "does not compile",
		"ビルド失敗", "コンパイルエラー",
	}, []string{
		"予測", "チェック", "検出", "detect", "prediction", "check for", "heuristic",
		"パターン", "pattern", "ゲート", "gate", "pipeline",
	}) {
		issues = append(issues, "Unresolved build failure mentioned in last response")
	}

	return issues
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
		unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if unresolved {
			issues = append(issues, fmt.Sprintf("Unresolved %s in %s", f.FailureType, filepath.Base(f.FilePath)))
			break // report only the most recent
		}
	}

	// Check if tests were run when code was modified.
	taskType, _ := sdb.GetWorkingSet("task_type")
	if taskType == "bugfix" || taskType == "feature" || taskType == "refactor" {
		hasTestRun, _ := sdb.GetContext("has_test_run")
		files, _ := sdb.GetWorkingSetFiles()
		if hasTestRun != "true" && len(files) > 0 {
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
