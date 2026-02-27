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

	// Session-aware pre-check: read ground truth from sessiondb.
	hasCodeChanges := false
	var testsPassed, buildPassed bool
	if in.SessionID != "" {
		if sdb, err := sessiondb.Open(in.SessionID); err == nil {
			files, _ := sdb.GetWorkingSetFiles()
			hasCodeChanges = len(files) > 0
			if v, _ := sdb.GetContext("last_test_passed"); v == "true" {
				testsPassed = true
			}
			if v, _ := sdb.GetContext("last_build_passed"); v == "true" {
				buildPassed = true
			}
			sdb.Close()
		}
	}

	var issues []string

	// Always check for explicit TODO/FIXME markers and incomplete work in assistant message.
	// These indicate unfinished intent regardless of whether code was modified.
	issues = checkCompleteness(in.LastAssistantMessage, hasCodeChanges)

	// Filter out text-based failure detections when sessiondb confirms actual state.
	// This prevents false positives from feature descriptions, examples, and summaries
	// that mention failure keywords in a non-failure context.
	if testsPassed || buildPassed {
		filtered := issues[:0]
		for _, issue := range issues {
			if testsPassed && strings.Contains(issue, "test failure") {
				continue
			}
			if buildPassed && strings.Contains(issue, "build failure") {
				continue
			}
			filtered = append(filtered, issue)
		}
		issues = filtered
	}

	// Session-aware checks using sessiondb.
	issues = append(issues, checkSessionIssues(in.SessionID)...)

	if len(issues) > 0 {
		return makeBlockStopOutput(strings.Join(issues, "; ")), nil
	}

	// Uncommitted changes: log to stderr. Suggest commit if tests passed.
	if gitInfo := checkUncommittedChanges(in.SessionID, in.CWD); gitInfo != "" {
		fmt.Fprintf(os.Stderr, "[buddy] %s\n", gitInfo)
	}
	if suggestion := suggestCommitAction(in.SessionID, in.CWD); suggestion != "" {
		fmt.Fprintf(os.Stderr, "[buddy] %s\n", suggestion)
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
		// Exclusion words: terms that appear near failure keywords in feature
		// descriptions, summaries, and documentation rather than actual failure reports.
		featureExclusions := []string{
			// English
			"detect", "prediction", "check for", "heuristic", "pattern", "gate",
			"pipeline", "hook", "block", "implement", "track", "monitor",
			"quality", "feature", "summary", "effect",
			// Japanese
			"予測", "チェック", "検出", "パターン", "ゲート", "ブロック",
			"実装", "追跡", "監視", "品質", "機能", "効果", "強化", "状態で",
			"サマリ", "完了",
		}

		if containsFailureReport(lower, []string{
			"test fail", "tests fail", "test failed", "tests failed", "failing test",
			"テストが失敗", "テスト失敗",
		}, featureExclusions) {
			issues = append(issues, "Unresolved test failure mentioned in last response")
		}

		if containsFailureReport(lower, []string{
			"build failed", "compilation error", "compile error", "does not compile",
			"ビルド失敗", "コンパイルエラー",
		}, featureExclusions) {
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

// checkSessionIssues uses the session database to detect unresolved failures,
// untested code modifications, build failures, and test failures.
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

	// Check build status: block if last build failed.
	if issue := checkBuildStatus(sdb); issue != "" {
		issues = append(issues, issue)
	}

	// Check test results: block if tests ran but failed.
	if issue := checkTestResults(sdb); issue != "" {
		issues = append(issues, issue)
	}

	// Block stopping when code was changed but tests were never run.
	taskType, _ := sdb.GetWorkingSet("task_type")
	if taskType == "bugfix" || taskType == "feature" || taskType == "refactor" {
		hasTestRun, _ := sdb.GetContext("has_test_run")
		if hasTestRun != "true" {
			msg := "Code was modified but tests were not run"
			cwd, _ := sdb.GetContext("cwd")
			if cmd := suggestTestsForFiles(files, cwd); cmd != "" {
				msg += " — run: " + cmd
			}
			issues = append(issues, msg)
		}
	}

	if len(files) >= 5 {
		fmt.Fprintf(os.Stderr, "[buddy] %d files modified — consider committing before stopping\n", len(files))
	}

	if issue := checkTestCoverage(sdb, files); issue != "" {
		fmt.Fprintf(os.Stderr, "[buddy] %s\n", issue)
	}

	return issues
}

// checkTestCoverage checks if modified source files have corresponding test files
// in the working set. Only flags when 3+ source files lack tests.
func checkTestCoverage(sdb *sessiondb.SessionDB, files []string) string {
	hasTestRun, _ := sdb.GetContext("has_test_run")
	if hasTestRun != "true" {
		return "" // already flagged by "tests not run" check
	}

	untested := 0
	for _, f := range files {
		base := filepath.Base(f)
		ext := filepath.Ext(f)

		// Skip test files themselves.
		if strings.Contains(base, "_test") || strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") {
			continue
		}
		// Skip non-code files.
		if ext == "" || ext == ".md" || ext == ".json" || ext == ".yaml" || ext == ".yml" || ext == ".toml" {
			continue
		}

		// Check if a corresponding test file exists in the working set.
		// Match by language-specific naming conventions:
		//   Go: foo.go → foo_test.go
		//   JS/TS: foo.ts → foo.test.ts or foo.spec.ts
		//   Python: foo.py → test_foo.py or foo_test.py
		hasTest := false
		nameNoExt := strings.TrimSuffix(base, ext)
		for _, other := range files {
			otherBase := filepath.Base(other)
			otherExt := filepath.Ext(other)
			otherNoExt := strings.TrimSuffix(otherBase, otherExt)
			switch {
			case otherNoExt == nameNoExt+"_test":                                  // Go: foo_test.go
			case otherNoExt == nameNoExt+".test" || otherNoExt == nameNoExt+".spec": // JS: foo.test.ts
			case otherNoExt == "test_"+nameNoExt:                                   // Python: test_foo.py
			default:
				continue
			}
			hasTest = true
			break
		}
		if !hasTest {
			untested++
		}
	}

	if untested >= 3 {
		return fmt.Sprintf("%d modified source files have no corresponding test files in this session", untested)
	}
	return ""
}

// checkBuildStatus returns a blocking message if the last build/compile failed.
func checkBuildStatus(sdb *sessiondb.SessionDB) string {
	lastBuild, _ := sdb.GetContext("last_build_passed")
	if lastBuild == "false" {
		return "Last build failed — fix compilation errors before stopping"
	}
	return ""
}

// checkTestResults returns a blocking message if tests were run but failed.
func checkTestResults(sdb *sessiondb.SessionDB) string {
	hasTestRun, _ := sdb.GetContext("has_test_run")
	if hasTestRun != "true" {
		return ""
	}
	lastTestPassed, _ := sdb.GetContext("last_test_passed")
	if lastTestPassed == "false" {
		return "Tests were run but failed — fix failing tests before stopping"
	}
	return ""
}

// suggestTestsForFiles returns a concrete test command based on modified Go source files.
func suggestTestsForFiles(files []string, cwd string) string {
	if cwd == "" {
		return "go test ./..."
	}
	pkgs := make(map[string]bool)
	for _, f := range files {
		if !strings.HasSuffix(f, ".go") || strings.HasSuffix(f, "_test.go") {
			continue
		}
		rel, _ := filepath.Rel(cwd, f)
		if rel == "" || strings.HasPrefix(rel, "..") {
			continue
		}
		pkg := "./" + filepath.Dir(rel)
		if pkg == "./" || pkg == "./." {
			pkgs["./..."] = true
		} else {
			pkgs[pkg+"/..."] = true
		}
	}
	if len(pkgs) == 0 {
		return "go test ./..."
	}
	if len(pkgs) > 3 {
		return "go test ./..."
	}
	var result []string
	for pkg := range pkgs {
		result = append(result, pkg)
	}
	return "go test " + strings.Join(result, " ")
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

// suggestCommitAction suggests committing when tests passed and files were modified.
func suggestCommitAction(sessionID, cwd string) string {
	if sessionID == "" {
		return ""
	}

	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		return ""
	}
	defer sdb.Close()

	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 {
		return ""
	}

	hasTestRun, _ := sdb.GetContext("has_test_run")
	lastTestPassed, _ := sdb.GetContext("last_test_passed")
	lastBuildPassed, _ := sdb.GetContext("last_build_passed")

	if hasTestRun != "true" || lastTestPassed != "true" {
		return ""
	}

	if lastBuildPassed == "false" {
		return ""
	}

	// Check if there are actually uncommitted changes in git.
	if cwd == "" {
		cwd, _ = sdb.GetContext("cwd")
	}
	if cwd == "" {
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	status, err := execGit(ctx, cwd, "status", "--porcelain")
	if err != nil || strings.TrimSpace(status) == "" {
		return ""
	}

	return fmt.Sprintf("Tests passed and %d file(s) modified — consider committing your changes", len(files))
}
