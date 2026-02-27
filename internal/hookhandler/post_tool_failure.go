package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

type postToolFailureInput struct {
	CommonInput
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	Error     string          `json:"error"`
	ToolUseID string          `json:"tool_use_id"`
}

func handlePostToolUseFailure(input []byte) (*HookOutput, error) {
	var in postToolFailureInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PostToolUseFailure: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// Cache task_type and velocity for contextual Thompson Sampling.
	SetDeliveryContext(sdb)

	// Verify pending resolution from previous tool call (failure path → false positive).
	verifyPendingResolution(sdb, false)

	// Classify the failure type.
	filePath := extractFilePath(in.ToolInput)
	failureType := classifyFailure(in.ToolName, in.Error)

	// Update EWMA flow metrics (failure path).
	updateFlowMetrics(sdb, true)

	// Reset success streak on failure.
	_ = sdb.SetContext("success_streak", "0")

	// Record failure for prediction (Phase 1B / 4A).
	_ = sdb.RecordFailure(in.ToolName, failureType, extractErrorSignature(in.Error), filePath)
	_ = sdb.RecordToolOutcome(in.ToolName, filePath, false)

	// Start solution chain tracking: record the failure signature so subsequent
	// tool calls are captured as the resolution sequence.
	errSig := extractErrorSignature(in.Error)
	chainSig := failureType + ":" + errSig
	if existing, _ := sdb.GetContext("chain_failure_sig"); existing == "" {
		_ = sdb.SetContext("chain_failure_sig", chainSig)
		_ = sdb.SetContext("chain_tool_seq", "")
		_ = sdb.SetContext("chain_step_count", "0")
	}

	// Track test/build failure status for Stop hook quality gate.
	if failureType == failTestFailure {
		_ = sdb.SetContext("has_test_run", "true")
		_ = sdb.SetContext("last_test_passed", "false")
	}
	if failureType == failCompileError {
		_ = sdb.SetContext("last_build_passed", "false")
	}

	// Record tool sequence with failure outcome.
	recordFailureSequence(sdb, in.ToolName)

	// Build context-aware fix suggestion.
	suggestion := buildFixSuggestion(sdb, in.SessionID, failureType, filePath, in.Error, in.ToolInput)

	// Cross-project fallback: search global DB when local solutions are empty.
	if suggestion == "" {
		if hint := searchCrossProjectSolutions(errSig); hint != "" {
			suggestion = hint
		}
	}

	// Failure cascade prediction: warn if next likely tools also have high failure rates.
	cascade := predictFailureCascade(sdb, in.ToolName)
	if cascade != "" {
		if suggestion != "" {
			suggestion += "\n" + cascade
		} else {
			suggestion = cascade
		}
	}

	if suggestion == "" {
		return nil, nil
	}

	return makeOutput("PostToolUseFailure", suggestion), nil
}

// failureType constants.
const (
	failEditMismatch  = "edit_mismatch"
	failBashError     = "bash_error"
	failFileNotFound  = "file_not_found"
	failPermission    = "permission_denied"
	failCompileError  = "compile_error"
	failTestFailure   = "test_failure"
	failGeneric       = "generic"
)

var (
	editMismatchPattern  = regexp.MustCompile(`(?i)(not found in file|old_string.*not|no match|does not match)`)
	fileNotFoundPattern  = regexp.MustCompile(`(?i)(no such file|not found|does not exist|ENOENT)`)
	permissionPattern    = regexp.MustCompile(`(?i)(permission denied|EACCES|read.only|not writable)`)
	compileErrorPattern  = regexp.MustCompile(`(?i)(syntax error|cannot find|undefined|undeclared|compile|compilation failed)`)
	testFailurePattern   = regexp.MustCompile(`(?i)(^FAIL\s|--- FAIL:|FAILED\s+::|test suite failed|tests?\s+failed)`)
)

// classifyFailure determines the type of failure from tool name and error message.
func classifyFailure(toolName, errorMsg string) string {
	switch toolName {
	case "Edit":
		if editMismatchPattern.MatchString(errorMsg) {
			return failEditMismatch
		}
		if fileNotFoundPattern.MatchString(errorMsg) {
			return failFileNotFound
		}
		if permissionPattern.MatchString(errorMsg) {
			return failPermission
		}
		return failEditMismatch // Edit failures are usually mismatches
	case "Write":
		if fileNotFoundPattern.MatchString(errorMsg) {
			return failFileNotFound
		}
		if permissionPattern.MatchString(errorMsg) {
			return failPermission
		}
		return failGeneric
	case "Read":
		if fileNotFoundPattern.MatchString(errorMsg) {
			return failFileNotFound
		}
		return failGeneric
	case "Bash":
		if compileErrorPattern.MatchString(errorMsg) {
			return failCompileError
		}
		if testFailurePattern.MatchString(errorMsg) {
			return failTestFailure
		}
		return failBashError
	default:
		if fileNotFoundPattern.MatchString(errorMsg) {
			return failFileNotFound
		}
		return failGeneric
	}
}

// buildFixSuggestion creates a context-aware fix suggestion based on failure type.
func buildFixSuggestion(sdb *sessiondb.SessionDB, sessionID, failureType, filePath, errorMsg string, toolInput json.RawMessage) string {
	var b strings.Builder

	switch failureType {
	case failEditMismatch:
		b.WriteString("[buddy] Edit failed — old_string not found in file.\n")
		b.WriteString("  WHY: The file content changed since your last Read. Another edit or auto-formatter may have modified it.\n")
		b.WriteString("→ Read the file first to get the exact current content, then retry with the correct old_string.")

		// Check how many times this file has had edit mismatches.
		failures, _ := sdb.RecentFailuresForFile(filePath, 5)
		mismatchCount := 0
		for _, f := range failures {
			if f.FailureType == failEditMismatch {
				mismatchCount++
			}
		}
		if mismatchCount >= 2 {
			fmt.Fprintf(&b, "\n→ This file has had %d edit mismatches. The file content may have changed — use Read with specific line range to verify.", mismatchCount)
		}

	case failFileNotFound:
		b.WriteString("[buddy] File not found.\n")
		b.WriteString("  WHY: The path does not exist on disk. It may have been moved, renamed, or never created.\n")
		if filePath != "" {
			if similar := findSimilarPaths(sdb, filePath); similar != "" {
				fmt.Fprintf(&b, "→ Did you mean: %s", similar)
			} else {
				b.WriteString("→ Use Glob to find the correct path.")
			}
		}

	case failPermission:
		fmt.Fprintf(&b, "[buddy] Permission denied for %s.\n", filepath.Base(filePath))
		b.WriteString("  WHY: The process lacks write permission. The file may be read-only, owned by another user, or in a protected directory.\n")
		b.WriteString("→ Check if the file is read-only or if the directory exists.")

	case failCompileError:
		b.WriteString("[buddy] Compilation error detected.\n")
		b.WriteString("  WHY: Recent edits likely introduced a syntax or type error.\n")
		if grouped := groupCompileErrors(errorMsg); grouped != "" {
			fmt.Fprintf(&b, "→ %s", grouped)
		} else if goFix := matchGoCompileError(errorMsg); goFix != "" {
			fmt.Fprintf(&b, "→ %s", goFix)
		} else if loc := extractCompileLocation(errorMsg); loc != "" {
			fmt.Fprintf(&b, "→ Error location: %s — Read that file to see the context.", loc)
		} else {
				b.WriteString("→ Read the error output carefully and fix the referenced file.")
		}

	case failTestFailure:
		b.WriteString("[buddy] Test failure detected.\n")
		if wsFiles, _ := sdb.GetWorkingSetFiles(); len(wsFiles) > 0 {
			limit := min(3, len(wsFiles))
			fmt.Fprintf(&b, "  WHY: You recently edited %s. The change likely broke an assumption in the test.\n",
				strings.Join(wsFiles[len(wsFiles)-limit:], ", "))
		} else {
			b.WriteString("  WHY: A test assertion failed, indicating behavior diverged from expected output.\n")
		}
		failures := extractTestFailures(errorMsg)
		if correlation := correlateWithRecentEdits(sdb, failures); correlation != "" {
			fmt.Fprintf(&b, "→ %s", correlation)
		} else {
			b.WriteString("→ Check the test output for the specific failing assertion.")
		}

	case failBashError:
		b.WriteString("[buddy] Command failed.\n")
		b.WriteString("  WHY: The shell command returned a non-zero exit code. Check if prerequisites are installed and paths are correct.\n")
		if solution := searchPastSolutions(sdb, failBashError, errorMsg); solution != "" {
			fmt.Fprintf(&b, "→ Past solution found: %s", solution)
		} else {
			var bi struct {
				Command string `json:"command"`
			}
			if json.Unmarshal(toolInput, &bi) == nil && bi.Command != "" {
				sig := extractCmdSignature(bi.Command)
				if sig != "" {
					_ = sdb.RecordBashFailure(sig, extractErrorSignature(errorMsg))
				}
			}
			b.WriteString("→ Review the error message and try an alternative approach.")
		}

	default:
		return ""
	}

	return b.String()
}

// extractFilePath extracts file_path from tool input JSON.
func extractFilePath(toolInput json.RawMessage) string {
	var fi struct {
		FilePath string `json:"file_path"`
	}
	if json.Unmarshal(toolInput, &fi) == nil {
		return fi.FilePath
	}
	return ""
}

// findSimilarPaths searches the working set for paths similar to the given path.
func findSimilarPaths(sdb *sessiondb.SessionDB, targetPath string) string {
	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 {
		return ""
	}

	targetBase := filepath.Base(targetPath)
	targetDir := filepath.Dir(targetPath)

	var matches []string
	for _, f := range files {
		// Match by base name similarity.
		if filepath.Base(f) == targetBase {
			matches = append(matches, f)
			continue
		}
		// Match by directory similarity.
		if filepath.Dir(f) == targetDir {
			matches = append(matches, f)
			continue
		}
		// Match by partial name.
		if strings.Contains(filepath.Base(f), strings.TrimSuffix(targetBase, filepath.Ext(targetBase))) {
			matches = append(matches, f)
		}
	}

	if len(matches) == 0 {
		return ""
	}
	if len(matches) > 3 {
		matches = matches[:3]
	}
	return strings.Join(matches, ", ")
}

// goCompilePatterns are deterministic Go compile error patterns with specific fixes.
// Checked before LLM fallback for instant, reliable suggestions (<1ms).
var goCompilePatterns = []struct {
	re  *regexp.Regexp
	fix string // %s placeholders filled from submatch groups
}{
	{regexp.MustCompile(`undefined: (\w+)`),
		"Identifier `%s` is not defined. Check spelling, imports, or if it needs to be exported (capitalized)."},
	{regexp.MustCompile(`imported and not used: "([^"]+)"`),
		"Import `%s` is unused. Remove it or use the package."},
	{regexp.MustCompile(`(\w+) declared (?:and )?not used`),
		"Variable `%s` is declared but not used. Use it or replace with `_`."},
	{regexp.MustCompile(`too many arguments in call to (\w+)`),
		"Too many arguments in call to `%s`. Check the function signature."},
	{regexp.MustCompile(`not enough arguments in call to (\w+)`),
		"Not enough arguments in call to `%s`. Check the function signature."},
	{regexp.MustCompile(`missing return at end of function`),
		"Missing return statement. Add a return at the end of the function."},
	{regexp.MustCompile(`cannot use (.+?) \(.*?(?:type |value of type )(.+?)\) as (?:type )?(.+?) `),
		"Type mismatch: `%s` is type `%s` but expected `%s`. Add a type conversion or fix the expression."},
	{regexp.MustCompile(`cannot assign to (.+)`),
		"Cannot assign to `%s`. Check if the target is addressable (not a map value, unexported field, etc.)."},
	{regexp.MustCompile(`syntax error: unexpected (.+?)(?:,|$)`),
		"Syntax error near `%s`. Check for missing braces, parentheses, or semicolons."},
}

// matchGoCompileError tries deterministic Go compile error patterns.
// Returns a specific fix suggestion or "" if no pattern matches.
func matchGoCompileError(errorMsg string) string {
	for _, p := range goCompilePatterns {
		m := p.re.FindStringSubmatch(errorMsg)
		if m == nil {
			continue
		}
		// Build args from captured groups (skip full match at m[0]).
		args := make([]any, len(m)-1)
		for i := 1; i < len(m); i++ {
			args[i-1] = m[i]
		}
		return fmt.Sprintf(p.fix, args...)
	}
	return ""
}

// extractCompileLocation extracts file:line from compiler error output.
var compileLocPattern = regexp.MustCompile(`(\S+\.(?:go|py|js|ts|rs|java|c|cpp)):(\d+)`)

func extractCompileLocation(errorMsg string) string {
	m := compileLocPattern.FindString(errorMsg)
	return m
}

// searchPastSolutions searches for past solutions to similar errors.
// Checks both the persistent failure_solutions table and vector search.
func searchPastSolutions(sdb *sessiondb.SessionDB, failureType, errorMsg string) string {
	errSig := extractErrorSignature(errorMsg)

	// Try persistent failure_solutions first, preferring those with exact diffs.
	st, err := store.OpenDefault()
	if err == nil {
		defer st.Close()
		solutions, _ := st.SearchFailureSolutionsWithDiff(failureType, errSig, 1)
		if len(solutions) > 0 {
			_ = st.IncrementTimesSurfaced(solutions[0].ID)
			_ = sdb.SetContext("last_surfaced_solution_id", fmt.Sprintf("%d", solutions[0].ID))

			// If a resolution diff is available, present the exact fix.
			if solutions[0].ResolutionDiff != "" {
				return formatResolutionDiff(solutions[0])
			}

			text := solutions[0].SolutionText
			if len([]rune(text)) > 150 {
				text = string([]rune(text)[:150]) + "..."
			}
			return text
		}
	}

	// Check for solution chains (multi-step playbooks).
	if err == nil {
		chains, _ := st.SearchSolutionChains(failureType+":"+errSig, 1)
		if len(chains) > 0 {
			_ = st.IncrementChainReplayed(chains[0].ID)
			return fmt.Sprintf("Past resolution playbook (%d steps): %s", chains[0].StepCount, chains[0].ToolSequence)
		}
	}

	// Fall back to vector-based pattern search.
	solutions := searchErrorSolutions(sdb, errSig)
	if len(solutions) == 0 {
		return ""
	}
	return formatSolution(solutions[0])
}

// formatResolutionDiff formats a failure solution with an exact diff for display.
func formatResolutionDiff(fs store.FailureSolution) string {
	var diff struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if json.Unmarshal([]byte(fs.ResolutionDiff), &diff) != nil {
		return fs.SolutionText
	}

	old := diff.Old
	new := diff.New
	if len([]rune(old)) > 80 {
		old = string([]rune(old)[:80]) + "..."
	}
	if len([]rune(new)) > 80 {
		new = string([]rune(new)[:80]) + "..."
	}
	return fmt.Sprintf("Past fix for %s in %s: change `%s` to `%s`",
		fs.FailureType, filepath.Base(fs.FilePath), old, new)
}

// predictFailureCascade checks if the next likely tools (based on session bigrams)
// also have high failure rates. If so, warns the user to try a different approach.
func predictFailureCascade(sdb *sessiondb.SessionDB, currentTool string) string {
	predictions, err := sdb.PredictNextTools(currentTool, 3)
	if err != nil || len(predictions) == 0 {
		return ""
	}

	var atRisk []string
	for _, p := range predictions {
		if p.Count < 3 {
			continue // insufficient data to predict reliably
		}
		if p.SuccessRate < 0.5 {
			atRisk = append(atRisk, fmt.Sprintf("%s (%.0f%% fail rate)", p.Tool, (1-p.SuccessRate)*100))
		}
	}
	if len(atRisk) == 0 {
		return ""
	}

	return fmt.Sprintf("[buddy] cascade-risk: Next likely tools also have high failure rates: %s. Consider a different approach instead of retrying.",
		strings.Join(atRisk, ", "))
}

// recordFailureSequence records a tool sequence ending in failure (bigram + trigram)
// and advances the sequence pointers so the next tool call has correct predecessors.
func recordFailureSequence(sdb *sessiondb.SessionDB, toolName string) {
	prevTool, _ := sdb.GetContext("prev_tool")
	if prevTool != "" {
		_ = sdb.RecordSequence(prevTool, toolName, "failure")
	}
	prevPrevTool, _ := sdb.GetContext("prev_prev_tool")
	if prevPrevTool != "" && prevTool != "" {
		_ = sdb.RecordTrigram(prevPrevTool, prevTool, toolName, "failure")
	}
	// Advance sequence pointers (same as success path in post_tool_use.go).
	_ = sdb.SetContext("prev_prev_tool", prevTool)
	_ = sdb.SetContext("prev_tool", toolName)
}

// Root cause identification patterns for compile error grouping.
var (
	goErrLineRe             = regexp.MustCompile(`(\S+\.go):(\d+):(?:\d+:)?\s*(.+)`)
	rootCauseUndefinedRe    = regexp.MustCompile(`undefined: (\w+)`)
	rootCauseUnusedImportRe = regexp.MustCompile(`"([^"]+)" imported and not used`)
	rootCauseTypeMismatchRe = regexp.MustCompile(`cannot use .+ as (?:type )?(\S+)`)
)

// groupCompileErrors identifies common root causes in multi-error compile output.
// Groups related errors (e.g., multiple "undefined: X") to surface the primary root cause,
// so the user fixes the root cause first instead of chasing cascading errors.
func groupCompileErrors(errorMsg string) string {
	lines := strings.Split(errorMsg, "\n")

	type parsedErr struct {
		file string
		msg  string
	}

	var errs []parsedErr
	for _, line := range lines {
		m := goErrLineRe.FindStringSubmatch(strings.TrimSpace(line))
		if m != nil {
			errs = append(errs, parsedErr{file: filepath.Base(m[1]), msg: m[3]})
		}
	}

	if len(errs) < 2 {
		return ""
	}

	// Extract root cause identifiers and track affected files.
	type causeInfo struct {
		label string
		count int
		files map[string]bool
	}
	causes := make(map[string]*causeInfo)

	addCause := func(key, label, file string) {
		if c, ok := causes[key]; ok {
			c.count++
			c.files[file] = true
		} else {
			causes[key] = &causeInfo{label: label, count: 1, files: map[string]bool{file: true}}
		}
	}

	for _, e := range errs {
		if m := rootCauseUndefinedRe.FindStringSubmatch(e.msg); m != nil {
			addCause("undefined:"+m[1], "`"+m[1]+"` is undefined", e.file)
		} else if m := rootCauseUnusedImportRe.FindStringSubmatch(e.msg); m != nil {
			addCause("import:"+m[1], "unused import `"+m[1]+"`", e.file)
		} else if m := rootCauseTypeMismatchRe.FindStringSubmatch(e.msg); m != nil {
			addCause("type:"+m[1], "type mismatch with `"+m[1]+"`", e.file)
		}
	}

	// Collect root causes with 2+ occurrences.
	var groups []string
	for _, c := range causes {
		if c.count < 2 {
			continue
		}
		files := make([]string, 0, len(c.files))
		for f := range c.files {
			files = append(files, f)
		}
		groups = append(groups, fmt.Sprintf("%s (%d errors in %s)", c.label, c.count, strings.Join(files, ", ")))
	}

	if len(groups) == 0 {
		if len(errs) >= 3 {
			return fmt.Sprintf("%d compile errors. Fix the first error — later errors often cascade.", len(errs))
		}
		return ""
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%d compile errors, %d root cause(s):", len(errs), len(groups))
	for i, g := range groups {
		if i >= 3 {
			break
		}
		fmt.Fprintf(&b, "\n  → %s", g)
	}
	b.WriteString("\nFix root cause(s) first — cascading errors resolve automatically.")
	return b.String()
}

// searchCrossProjectSolutions searches the global DB for error solutions from other projects.
func searchCrossProjectSolutions(errorSig string) string {
	if errorSig == "" {
		return ""
	}

	gs, err := store.OpenGlobal()
	if err != nil {
		return ""
	}
	defer gs.Close()

	patterns, err := gs.SearchPatterns(errorSig, "error_solution", 1)
	if err != nil || len(patterns) == 0 {
		return ""
	}

	p := patterns[0]
	text := p.Content
	if len([]rune(text)) > 150 {
		text = string([]rune(text)[:150]) + "..."
	}
	return fmt.Sprintf("[buddy] Cross-project solution (from %s):\n→ %s", p.SourceProject, text)
}

