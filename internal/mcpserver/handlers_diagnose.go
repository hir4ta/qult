package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/store"
)

func diagnoseHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		errorMsg := req.GetString("error_output", "")
		if errorMsg == "" {
			return mcp.NewToolResultError("error_output parameter is required"), nil
		}
		toolName := req.GetString("tool_name", "")
		filePath := req.GetString("file_path", "")

		diag := buildDiagnosis(st, errorMsg, toolName, filePath)

		return marshalResult(diag)
	}
}

// diagnosis is the structured output of buddy_diagnose.
type diagnosis struct {
	FailureType   string            `json:"failure_type"`
	RootCause     string            `json:"root_cause"`
	Confidence    float64           `json:"confidence"`
	Location      string            `json:"location,omitempty"`
	PastSolutions []pastSolution    `json:"past_solutions,omitempty"`
	SolutionChain []string          `json:"solution_chain,omitempty"`
	StackFrames   []stackFrame      `json:"stack_frames,omitempty"`
	CoChangedWith []string          `json:"co_changed_with,omitempty"`
	Actions       []recommendAction `json:"recommended_actions"`
}

type pastSolution struct {
	Text       string  `json:"text"`
	Diff       string  `json:"diff,omitempty"`
	Confidence float64 `json:"confidence"`
}

type stackFrame struct {
	File     string `json:"file"`
	Line     string `json:"line,omitempty"`
	Function string `json:"function,omitempty"`
}

type recommendAction struct {
	Action  string `json:"action"`
	Command string `json:"command,omitempty"`
	Why     string `json:"why"`
}

func buildDiagnosis(st *store.Store, errorMsg, toolName, filePath string) *diagnosis {
	d := &diagnosis{
		Confidence: 0.5,
	}

	// 1. Classify the failure type.
	d.FailureType = classifyError(toolName, errorMsg)

	// 2. Extract error location.
	if loc := extractLocation(errorMsg); loc != "" {
		d.Location = loc
		if filePath == "" {
			filePath = strings.SplitN(loc, ":", 2)[0]
		}
	}

	// 3. Parse stack frames.
	d.StackFrames = parseStackFrames(errorMsg)

	// 4. Determine root cause.
	d.RootCause, d.Confidence = determineRootCause(d.FailureType, errorMsg, toolName)

	// 5. Search past solutions.
	if st != nil {
		sig := extractSig(errorMsg)
		d.PastSolutions = searchSolutions(st, d.FailureType, sig, filePath)
		d.SolutionChain = searchChains(st, d.FailureType, sig)

		// 6. File co-changes for blast radius.
		if filePath != "" {
			coChanges, _ := st.CoChangedFiles(filePath, 5)
			for _, cc := range coChanges {
				if cc.SessionCount < 2 {
					continue
				}
				other := cc.FileB
				if other == filePath {
					other = cc.FileA
				}
				d.CoChangedWith = append(d.CoChangedWith, fmt.Sprintf("%s (%d sessions)", filepath.Base(other), cc.SessionCount))
			}
		}
	}

	// 7. Build recommended actions.
	d.Actions = buildActions(d, filePath)

	return d
}

// classifyError determines failure type from tool name and error message.
func classifyError(toolName, errorMsg string) string {
	msg := strings.ToLower(errorMsg)
	switch {
	case strings.Contains(msg, "not found in file") || strings.Contains(msg, "old_string"):
		return "edit_mismatch"
	case strings.Contains(msg, "no such file") || strings.Contains(msg, "does not exist"):
		return "file_not_found"
	case strings.Contains(msg, "permission denied"):
		return "permission"
	case strings.Contains(msg, "undefined") || strings.Contains(msg, "syntax error") ||
		strings.Contains(msg, "compile") || strings.Contains(msg, "undeclared"):
		return "compile_error"
	case strings.Contains(msg, "fail") && (strings.Contains(msg, "test") || strings.Contains(msg, "--- fail")):
		return "test_failure"
	default:
		if toolName == "Edit" {
			return "edit_mismatch"
		}
		return "runtime_error"
	}
}

// determineRootCause provides a human-readable root cause and confidence.
func determineRootCause(failureType, errorMsg, _ /* toolName */ string) (string, float64) {
	switch failureType {
	case "edit_mismatch":
		return "The old_string does not match current file content. The file may have changed since the last Read, or whitespace/indentation differs from what was expected.", 0.9
	case "file_not_found":
		return "The target file or directory does not exist. Check the path for typos, or the file may have been moved/deleted.", 0.95
	case "permission":
		return "Insufficient permissions to access the file. Check file ownership and write permissions.", 0.95
	case "compile_error":
		if fix := matchCompilePattern(errorMsg); fix != "" {
			return fix, 0.9
		}
		return "Compilation failed. Check the error output for specific file:line locations and fix syntax/type errors.", 0.6
	case "test_failure":
		return "One or more tests failed. The recent code changes likely broke an existing assertion or introduced a regression.", 0.7
	default:
		return "Command failed. Review the error output for specific error messages.", 0.4
	}
}

// matchCompilePattern tries deterministic compile error patterns.
var diagCompilePatterns = []struct {
	re  *regexp.Regexp
	fix string
}{
	{regexp.MustCompile(`undefined: (\w+)`),
		"Identifier `%s` is not defined. Check spelling, imports, or if it needs to be exported."},
	{regexp.MustCompile(`imported and not used: "([^"]+)"`),
		"Import `%s` is unused. Remove it or use the package."},
	{regexp.MustCompile(`(\w+) declared (?:and )?not used`),
		"Variable `%s` is declared but not used."},
	{regexp.MustCompile(`missing return at end of function`),
		"Missing return statement at the end of the function."},
	{regexp.MustCompile(`cannot use (.+?) \(.*?(?:type |value of type )(.+?)\) as (?:type )?(.+?) `),
		"Type mismatch: `%s` is `%s` but expected `%s`."},
	{regexp.MustCompile(`syntax error: unexpected (.+?)(?:,|$)`),
		"Syntax error near `%s`. Check for missing braces, parentheses, or semicolons."},
}

func matchCompilePattern(errorMsg string) string {
	for _, p := range diagCompilePatterns {
		m := p.re.FindStringSubmatch(errorMsg)
		if m == nil {
			continue
		}
		args := make([]any, len(m)-1)
		for i := 1; i < len(m); i++ {
			args[i-1] = m[i]
		}
		return fmt.Sprintf(p.fix, args...)
	}
	return ""
}

// extractLocation finds file:line in error output.
var locPattern = regexp.MustCompile(`(\S+\.(?:go|py|js|ts|rs|java|c|cpp)):(\d+)`)

func extractLocation(errorMsg string) string {
	return locPattern.FindString(errorMsg)
}

// parseStackFrames extracts structured frames from stack traces.
var (
	goFramePattern     = regexp.MustCompile(`(?m)^\s*(\S+\.go):(\d+)\s`)
	pythonFramePattern = regexp.MustCompile(`File "([^"]+)", line (\d+)(?:, in (\w+))?`)
	jsFramePattern     = regexp.MustCompile(`at\s+(?:(\S+)\s+)?\(?([^:]+):(\d+)`)
)

func parseStackFrames(errorMsg string) []stackFrame {
	var frames []stackFrame
	seen := make(map[string]bool)

	// Try Python frames.
	for _, m := range pythonFramePattern.FindAllStringSubmatch(errorMsg, 10) {
		key := m[1] + ":" + m[2]
		if seen[key] {
			continue
		}
		seen[key] = true
		f := stackFrame{File: m[1], Line: m[2]}
		if len(m) > 3 {
			f.Function = m[3]
		}
		frames = append(frames, f)
	}
	if len(frames) > 0 {
		return frames
	}

	// Try JS frames.
	for _, m := range jsFramePattern.FindAllStringSubmatch(errorMsg, 10) {
		key := m[2] + ":" + m[3]
		if seen[key] {
			continue
		}
		seen[key] = true
		f := stackFrame{File: m[2], Line: m[3]}
		if m[1] != "" {
			f.Function = m[1]
		}
		frames = append(frames, f)
	}
	if len(frames) > 0 {
		return frames
	}

	// Try Go frames.
	for _, m := range goFramePattern.FindAllStringSubmatch(errorMsg, 10) {
		key := m[1] + ":" + m[2]
		if seen[key] {
			continue
		}
		seen[key] = true
		frames = append(frames, stackFrame{File: m[1], Line: m[2]})
	}

	return frames
}

// extractSig extracts a short error signature for searching.
func extractSig(errorMsg string) string {
	lines := strings.Split(errorMsg, "\n")
	indicators := []string{"error", "Error", "ERROR", "failed", "FAILED", "FAIL", "panic"}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		for _, ind := range indicators {
			if strings.Contains(trimmed, ind) {
				if len([]rune(trimmed)) > 80 {
					trimmed = string([]rune(trimmed)[:80])
				}
				return trimmed
			}
		}
	}
	if len(lines) > 0 {
		trimmed := strings.TrimSpace(lines[0])
		if len([]rune(trimmed)) > 80 {
			trimmed = string([]rune(trimmed)[:80])
		}
		return trimmed
	}
	return ""
}

func searchSolutions(st *store.Store, failureType, errorSig, filePath string) []pastSolution {
	var results []pastSolution

	// Try signature-based search first.
	solutions, _ := st.SearchFailureSolutionsWithDiff(failureType, errorSig, 3)
	for _, sol := range solutions {
		ps := pastSolution{
			Text:       sol.SolutionText,
			Confidence: 0.7,
		}
		if sol.ResolutionDiff != "" {
			ps.Diff = sol.ResolutionDiff
			ps.Confidence = 0.85
		}
		if sol.TimesEffective > 0 && sol.TimesSurfaced > 0 {
			ps.Confidence = float64(sol.TimesEffective) / float64(sol.TimesSurfaced)
		}
		results = append(results, ps)
	}

	// Try file-based search if no signature matches.
	if len(results) == 0 && filePath != "" {
		fileSolutions, _ := st.SearchFailureSolutionsByFile(filePath, 2)
		for _, sol := range fileSolutions {
			ps := pastSolution{
				Text:       sol.SolutionText,
				Confidence: 0.5,
			}
			if sol.ResolutionDiff != "" {
				ps.Diff = sol.ResolutionDiff
				ps.Confidence = 0.65
			}
			results = append(results, ps)
		}
	}

	return results
}

func searchChains(st *store.Store, failureType, errorSig string) []string {
	sig := failureType + ":" + errorSig
	chains, _ := st.SearchSolutionChains(sig, 1)
	if len(chains) == 0 {
		return nil
	}

	var toolSeq []string
	_ = json.Unmarshal([]byte(chains[0].ToolSequence), &toolSeq)
	return toolSeq
}

func buildActions(d *diagnosis, filePath string) []recommendAction {
	var actions []recommendAction

	switch d.FailureType {
	case "edit_mismatch":
		actions = append(actions, recommendAction{
			Action: "Re-read the file to get current content",
			Why:    "Edit matches against current content. A fresh Read ensures your old_string is exact.",
		})
		if filePath != "" {
			actions = append(actions, recommendAction{
				Action:  "Read the target file",
				Command: "Read " + filePath,
				Why:     "Get exact current content before retrying the edit.",
			})
		}
	case "file_not_found":
		actions = append(actions, recommendAction{
			Action:  "Search for the correct file path",
			Command: "Glob **/" + filepath.Base(filePath),
			Why:     "The file may exist at a different path. Glob finds it regardless of directory.",
		})
	case "compile_error":
		if d.Location != "" {
			actions = append(actions, recommendAction{
				Action:  "Read the error location",
				Command: "Read " + d.Location,
				Why:     "See the exact code at the error location to understand the context.",
			})
		}
		actions = append(actions, recommendAction{
			Action:  "Fix and rebuild",
			Command: "go build ./...",
			Why:     "Verify the fix compiles before running tests.",
		})
	case "test_failure":
		actions = append(actions, recommendAction{
			Action: "Read the failing test to understand the assertion",
			Why:    "Understanding what the test expects reveals why your change broke it.",
		})
		actions = append(actions, recommendAction{
			Action: "Run only the failing test with verbose output",
			Why:    "Isolated test run gives clearer output than full suite.",
		})
	default:
		actions = append(actions, recommendAction{
			Action: "Review the error output carefully for specific error messages",
			Why:    "The root cause is often stated explicitly in the output but buried in noise.",
		})
	}

	// Add past solution replay if available.
	if len(d.SolutionChain) > 0 {
		actions = append(actions, recommendAction{
			Action: fmt.Sprintf("Follow past solution chain: %s", strings.Join(d.SolutionChain, " → ")),
			Why:    "This tool sequence resolved the same error in a previous session.",
		})
	}

	// Add co-change awareness.
	if len(d.CoChangedWith) > 0 {
		actions = append(actions, recommendAction{
			Action: fmt.Sprintf("Check related files: %s", strings.Join(d.CoChangedWith, ", ")),
			Why:    "These files often change together. The root cause may span multiple files.",
		})
	}

	return actions
}
