package hookhandler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/advice"
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

	// Classify the failure type.
	filePath := extractFilePath(in.ToolInput)
	failureType := classifyFailure(in.ToolName, in.Error)

	// Record failure for prediction (Phase 1B / 4A).
	_ = sdb.RecordFailure(in.ToolName, failureType, extractErrorSignature(in.Error), filePath)
	_ = sdb.RecordToolOutcome(in.ToolName, filePath, false)

	// Record tool sequence with failure outcome.
	recordFailureSequence(sdb, in.ToolName)

	// Build context-aware fix suggestion.
	suggestion := buildFixSuggestion(sdb, in.SessionID, failureType, filePath, in.Error, in.ToolInput)
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
// Uses deterministic rules first, then augments with LLM when available and useful.
func buildFixSuggestion(sdb *sessiondb.SessionDB, sessionID, failureType, filePath, errorMsg string, toolInput json.RawMessage) string {
	var b strings.Builder
	needsLLM := false // Flag: deterministic suggestion was generic, LLM could help.

	switch failureType {
	case failEditMismatch:
		b.WriteString("[buddy] Edit failed — old_string not found in file.\n")
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
		if filePath != "" {
			if similar := findSimilarPaths(sdb, filePath); similar != "" {
				fmt.Fprintf(&b, "→ Did you mean: %s", similar)
			} else {
				b.WriteString("→ Use Glob to find the correct path.")
			}
		}

	case failPermission:
		fmt.Fprintf(&b, "[buddy] Permission denied for %s.\n", filepath.Base(filePath))
		b.WriteString("→ Check if the file is read-only or if the directory exists.")

	case failCompileError:
		b.WriteString("[buddy] Compilation error detected.\n")
		if loc := extractCompileLocation(errorMsg); loc != "" {
			fmt.Fprintf(&b, "→ Error location: %s — Read that file to see the context.", loc)
		} else {
			needsLLM = true
			b.WriteString("→ Read the error output carefully and fix the referenced file.")
		}

	case failTestFailure:
		b.WriteString("[buddy] Test failure detected.\n")
		failures := extractTestFailures(errorMsg)
		if correlation := correlateWithRecentEdits(sdb, failures); correlation != "" {
			fmt.Fprintf(&b, "→ %s", correlation)
		} else {
			needsLLM = true
			b.WriteString("→ Check the test output for the specific failing assertion.")
		}

	case failBashError:
		b.WriteString("[buddy] Command failed.\n")
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
			needsLLM = true
			b.WriteString("→ Review the error message and try an alternative approach.")
		}

	default:
		return ""
	}

	// LLM augmentation: when deterministic suggestion was generic, try Ollama.
	if needsLLM {
		if llmSuggestion := tryLLMFixSuggestion(sdb, sessionID, failureType, errorMsg, filePath); llmSuggestion != "" {
			b.WriteString("\n")
			b.WriteString(llmSuggestion)
		}
	}

	return b.String()
}

// tryLLMFixSuggestion attempts to generate a context-aware fix via Ollama.
// Returns empty string on failure (caller keeps deterministic fallback).
// Records the emission in suggestion_outcomes for effectiveness tracking.
func tryLLMFixSuggestion(sdb *sessiondb.SessionDB, sessionID, failureType, errorMsg, filePath string) string {
	advisor := advice.NewFromSessionDB(sdb)
	if advisor == nil {
		return ""
	}

	recentContext := buildRecentContext(sdb)

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	fix, err := advisor.GenerateFixSuggestion(ctx, failureType, errorMsg, filePath, recentContext)
	if err != nil {
		advisor.RecordFailure(sdb)
		return ""
	}
	advisor.RecordSuccess(sdb)

	if fix.Confidence == "low" {
		return ""
	}

	var b strings.Builder
	fmt.Fprintf(&b, "→ [LLM] Root cause: %s", fix.RootCause)
	if fix.Suggestion != "" && fix.Suggestion != fix.RootCause {
		fmt.Fprintf(&b, "\n→ [LLM] Suggestion: %s", fix.Suggestion)
	}

	// Track LLM suggestion for effectiveness measurement.
	recordLLMSuggestionDelivery(sdb, sessionID, failureType, b.String())

	return b.String()
}

// recordLLMSuggestionDelivery records an LLM-generated suggestion in the persistent store.
func recordLLMSuggestionDelivery(sdb *sessiondb.SessionDB, sessionID, failureType, suggestion string) {
	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	pattern := "llm-fix:" + failureType
	id, err := st.InsertSuggestionOutcome(sessionID, pattern, suggestion)
	if err != nil {
		return
	}
	_ = sdb.SetContext("last_llm_outcome_id", fmt.Sprintf("%d", id))
}

// buildRecentContext assembles recent session context for LLM prompts.
func buildRecentContext(sdb *sessiondb.SessionDB) string {
	var parts []string

	if intent, _ := sdb.GetWorkingSet("intent"); intent != "" {
		parts = append(parts, "Task: "+intent)
	}
	if branch, _ := sdb.GetWorkingSet("git_branch"); branch != "" {
		parts = append(parts, "Branch: "+branch)
	}
	if files, _ := sdb.GetWorkingSetFiles(); len(files) > 0 {
		limit := min(5, len(files))
		parts = append(parts, "Editing: "+strings.Join(files[:limit], ", "))
	}

	return strings.Join(parts, "; ")
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

	// Try persistent failure_solutions first (cross-session knowledge).
	st, err := store.OpenDefault()
	if err == nil {
		defer st.Close()
		solutions, _ := st.SearchFailureSolutions(failureType, errSig, 1)
		if len(solutions) > 0 {
			_ = st.IncrementTimesSurfaced(solutions[0].ID)
			// Store surfaced solution ID for effectiveness tracking.
			_ = sdb.SetContext("last_surfaced_solution_id", fmt.Sprintf("%d", solutions[0].ID))
			text := solutions[0].SolutionText
			if len([]rune(text)) > 150 {
				text = string([]rune(text)[:150]) + "..."
			}
			return text
		}
	}

	// Fall back to vector-based pattern search.
	solutions := searchErrorSolutions(sdb, errSig)
	if len(solutions) == 0 {
		return ""
	}
	return formatSolution(solutions[0])
}

// recordFailureSequence records a tool sequence ending in failure.
func recordFailureSequence(sdb *sessiondb.SessionDB, toolName string) {
	prevTool, _ := sdb.GetContext("prev_tool")
	if prevTool != "" {
		_ = sdb.RecordSequence(prevTool, toolName, "failure")
	}
}

