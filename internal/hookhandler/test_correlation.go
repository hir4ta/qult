package hookhandler

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// testFailure represents an extracted test failure.
type testFailure struct {
	TestName     string
	ErrorMessage string
}

// testFailurePatterns matches common test failure output formats.
var testFailurePatterns = []*regexp.Regexp{
	// Go: --- FAIL: TestName (0.01s)
	regexp.MustCompile(`---\s*FAIL:\s*(\S+)`),
	// Python: FAILED test_file.py::test_name
	regexp.MustCompile(`FAILED\s+\S+::(\w+)`),
	// Jest/Vitest: FAIL src/test.ts (path must contain / or .)
	regexp.MustCompile(`(?m)^\s*FAIL\s+(\S*[/.]\S+)`),
}

// extractTestFailures parses test runner output for failures.
func extractTestFailures(output string) []testFailure {
	var failures []testFailure
	seen := make(map[string]bool)

	for _, p := range testFailurePatterns {
		matches := p.FindAllStringSubmatch(output, 5)
		for _, m := range matches {
			if len(m) < 2 {
				continue
			}
			name := m[1]
			if seen[name] {
				continue
			}
			seen[name] = true
			failures = append(failures, testFailure{
				TestName:     name,
				ErrorMessage: extractNearbyError(output, m[0]),
			})
		}
	}
	return failures
}

// correlateWithRecentEdits finds recently edited files that may relate to test failures.
// When a coverage map is available, provides precise function-level correlation.
func correlateWithRecentEdits(sdb *sessiondb.SessionDB, failures []testFailure) string {
	if len(failures) == 0 {
		return ""
	}

	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 {
		return ""
	}

	// Try coverage map for precise function-level correlation.
	cm := LoadCoverageMap(sdb)
	if cm != nil && len(cm.FuncToTests) > 0 {
		if correlation := correlateViaCoverageMap(cm, failures, files); correlation != "" {
			return correlation
		}
	}

	// Fall back to file-list based correlation.
	var b strings.Builder
	f := failures[0] // focus on first failure
	fmt.Fprintf(&b, "Test %s failed", f.TestName)
	if f.ErrorMessage != "" {
		fmt.Fprintf(&b, ": %s", f.ErrorMessage)
	}
	b.WriteString("\nRecently edited files that may be related:\n")
	limit := min(5, len(files))
	for i := len(files) - limit; i < len(files); i++ {
		fmt.Fprintf(&b, "  - %s\n", files[i])
	}

	if len(failures) > 1 {
		fmt.Fprintf(&b, "(%d additional test failure(s))", len(failures)-1)
	}

	return b.String()
}

// correlateViaCoverageMap uses the coverage map to find precise causal links
// between test failures and recently edited functions.
func correlateViaCoverageMap(cm *CoverageMap, failures []testFailure, editedFiles []string) string {
	editedBases := make(map[string]string) // base name → full path
	for _, f := range editedFiles {
		editedBases[filepath.Base(f)] = f
	}

	for _, f := range failures {
		// Reverse lookup: find which functions this test covers.
		for key, tests := range cm.FuncToTests {
			for _, t := range tests {
				if t != f.TestName {
					continue
				}
				// key = "relative/path.go:FuncName"
				parts := strings.SplitN(key, ":", 2)
				if len(parts) != 2 {
					continue
				}
				srcFile := parts[0]
				funcName := parts[1]
				// Check if source file was recently edited.
				if _, edited := editedBases[filepath.Base(srcFile)]; edited {
					var b strings.Builder
					fmt.Fprintf(&b, "Cause: %s covers %s in %s (which you edited)", f.TestName, funcName, filepath.Base(srcFile))
					if cmd := SuggestTestCommand(cm, editedBases[filepath.Base(srcFile)], []string{funcName}, ""); cmd != "" {
						fmt.Fprintf(&b, "\n→ Run: %s", cmd)
					}
					return b.String()
				}
			}
		}
	}
	return ""
}

// extractNearbyError extracts the error message near a failure marker in test output.
func extractNearbyError(output, marker string) string {
	idx := strings.Index(output, marker)
	if idx < 0 {
		return ""
	}

	// Take up to 200 chars after the marker.
	start := idx + len(marker)
	end := start + 200
	if end > len(output) {
		end = len(output)
	}
	snippet := output[start:end]

	// Return the first non-empty line with content.
	for _, line := range strings.Split(snippet, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || len(trimmed) < 5 {
			continue
		}
		if len([]rune(trimmed)) > 100 {
			trimmed = string([]rune(trimmed)[:100]) + "..."
		}
		return trimmed
	}
	return ""
}
