package hookhandler

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// codeHeuristic represents a single code quality check.
type codeHeuristic struct {
	Name     string
	Language string // file extension trigger (e.g. "go", "py"), "" for all languages
	Check    func(filePath, content string) string
}

var codeHeuristics = []codeHeuristic{
	{Name: "go_unchecked_error", Language: "go", Check: checkGoUncheckedError},
	{Name: "go_debug_print", Language: "go", Check: checkGoDebugPrint},
	{Name: "go_defer_in_loop", Language: "go", Check: checkGoDeferInLoop},
	{Name: "go_goroutine_leak", Language: "go", Check: checkGoGoroutineLeak},
	{Name: "go_nil_error_wrap", Language: "go", Check: checkGoNilErrorWrap},
	{Name: "go_empty_error_return", Language: "go", Check: checkGoEmptyErrorReturn},
	{Name: "todo_without_ticket", Language: "", Check: checkTODOWithoutTicket},
	{Name: "py_bare_except", Language: "py", Check: checkPyBareExcept},
	{Name: "py_mutable_default", Language: "py", Check: checkPyMutableDefault},
	{Name: "py_star_import", Language: "py", Check: checkPyStarImport},
	{Name: "js_console_log", Language: "js", Check: checkJSConsoleLog},
	{Name: "js_loose_equality", Language: "js", Check: checkJSLooseEquality},
	{Name: "js_async_no_await", Language: "js", Check: checkJSAsyncNoAwait},
	{Name: "hardcoded_secret", Language: "", Check: checkHardcodedSecret},
	{Name: "sql_injection", Language: "", Check: checkSQLInjection},
	{Name: "large_function", Language: "go", Check: checkLargeFunction},
}

// runCodeHeuristics checks edited/written content against code quality patterns.
// Returns an observation string, or "" if no issues found.
func runCodeHeuristics(filePath string, toolInput json.RawMessage) string {
	ext := fileExtFromPath(filePath)
	content := extractWriteContent(toolInput)
	if content == "" {
		return ""
	}

	for _, h := range codeHeuristics {
		if h.Language != "" && h.Language != ext {
			continue
		}
		if suggestion := h.Check(filePath, content); suggestion != "" {
			return suggestion
		}
	}
	return ""
}

// --- Individual checks ---

var goUncheckedErrPattern = regexp.MustCompile(`_\s*(?:,\s*_\s*)?=\s*\w+\.?\w+\(`)

func checkGoUncheckedError(_, content string) string {
	if !goUncheckedErrPattern.MatchString(content) {
		return ""
	}
	return "Discarded error with `_ =` — consider handling or adding justification comment"
}

var goDebugPrintPattern = regexp.MustCompile(`\bfmt\.Print(ln|f)?\(`)

func checkGoDebugPrint(filePath, content string) string {
	if strings.HasSuffix(filePath, "_test.go") {
		return ""
	}
	if !goDebugPrintPattern.MatchString(content) {
		return ""
	}
	return "fmt.Println detected in non-test file — remove debug prints before committing"
}

var todoPattern = regexp.MustCompile(`(?i)\bTODO\b`)
var todoWithTicket = regexp.MustCompile(`(?i)\bTODO\s*[\(:]?\s*[A-Z]+-\d+`)

func checkTODOWithoutTicket(_, content string) string {
	if !todoPattern.MatchString(content) {
		return ""
	}
	if todoWithTicket.MatchString(content) {
		return ""
	}
	return "TODO without ticket reference — consider linking to an issue"
}

var pyBareExceptPattern = regexp.MustCompile(`\bexcept\s*:`)

func checkPyBareExcept(_, content string) string {
	if !pyBareExceptPattern.MatchString(content) {
		return ""
	}
	return "Bare `except:` catches all exceptions including KeyboardInterrupt — specify the exception type"
}

var jsConsoleLogPattern = regexp.MustCompile(`\bconsole\.log\(`)

func checkJSConsoleLog(filePath, content string) string {
	base := filepath.Base(filePath)
	if strings.Contains(base, ".test.") || strings.Contains(base, "_test.") || strings.Contains(base, ".spec.") {
		return ""
	}
	if !jsConsoleLogPattern.MatchString(content) {
		return ""
	}
	return "console.log detected — remove debug logs before committing"
}

var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(password|secret|api_key|apikey|api_secret)\s*[:=]\s*["'][^"']{8,}`),
	regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9\-._~+/]{20,}`),
}

func checkHardcodedSecret(_, content string) string {
	for _, p := range secretPatterns {
		if p.MatchString(content) {
			return "Potential hardcoded secret detected — consider using environment variables"
		}
	}
	return ""
}

// --- Go: defer in loop ---

// Matches `defer` inside a `for` block. Uses (?s) so `.` matches newlines,
// and a lazy quantifier to stay within the nearest closing brace.
var goDeferInLoopPattern = regexp.MustCompile(`(?s)\bfor\b[^{]*\{.{0,500}?\bdefer\b`)

func checkGoDeferInLoop(filePath, content string) string {
	if strings.HasSuffix(filePath, "_test.go") {
		return ""
	}
	if !goDeferInLoopPattern.MatchString(content) {
		return ""
	}
	return "`defer` inside loop — deferred calls accumulate until function returns, not loop iteration"
}

// --- Go: goroutine without context/done ---

var goGoroutinePattern = regexp.MustCompile(`\bgo\s+func\s*\(`)

func checkGoGoroutineLeak(filePath, content string) string {
	if strings.HasSuffix(filePath, "_test.go") {
		return ""
	}
	locs := goGoroutinePattern.FindAllStringIndex(content, -1)
	if len(locs) == 0 {
		return ""
	}
	// Check surrounding context (500 chars) of each goroutine for lifecycle management.
	for _, loc := range locs {
		start := max(0, loc[0]-200)
		end := min(len(content), loc[1]+300)
		nearby := content[start:end]
		if strings.Contains(nearby, "ctx") || strings.Contains(nearby, "done") ||
			strings.Contains(nearby, "cancel") || strings.Contains(nearby, "wg.") ||
			strings.Contains(nearby, "errgroup") {
			continue
		}
		return "`go func()` without context, done channel, or WaitGroup — goroutine may leak"
	}
	return ""
}

// --- Go: wrapping nil error ---

var goNilWrapPattern = regexp.MustCompile(`fmt\.Errorf\([^)]*%w[^)]*,\s*nil\s*\)`)

func checkGoNilErrorWrap(_, content string) string {
	if !goNilWrapPattern.MatchString(content) {
		return ""
	}
	return "`fmt.Errorf` wrapping nil with %w — this creates a non-nil error containing nil"
}

// --- Go: swallowing error (return nil instead of err) ---

var goEmptyErrReturnPattern = regexp.MustCompile(`if\s+err\s*!=\s*nil\s*\{\s*return\s+nil\s*\}`)

func checkGoEmptyErrorReturn(filePath, content string) string {
	if strings.HasSuffix(filePath, "_test.go") {
		return ""
	}
	if !goEmptyErrReturnPattern.MatchString(content) {
		return ""
	}
	return "`if err != nil { return nil }` swallows the error — return the error or wrap it"
}

// --- Python: mutable default argument ---

var pyMutableDefaultPattern = regexp.MustCompile(`def\s+\w+\s*\([^)]*=\s*\[\s*\]`)

func checkPyMutableDefault(_, content string) string {
	if !pyMutableDefaultPattern.MatchString(content) {
		return ""
	}
	return "Mutable default argument `[]` — use `None` and assign inside the function body"
}

// --- Python: star import ---

var pyStarImportPattern = regexp.MustCompile(`(?m)^from\s+\S+\s+import\s+\*`)

func checkPyStarImport(_, content string) string {
	if !pyStarImportPattern.MatchString(content) {
		return ""
	}
	return "`from module import *` pollutes namespace — import specific names"
}

// --- JS/TS: loose equality ---

var jsLooseEqualityPattern = regexp.MustCompile(`[^!=]==[^=]`)
var jsNullCheckPattern = regexp.MustCompile(`==\s*null|null\s*==`)

func checkJSLooseEquality(filePath, content string) string {
	base := filepath.Base(filePath)
	if strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") {
		return ""
	}
	if !jsLooseEqualityPattern.MatchString(content) {
		return ""
	}
	// Allow == null (idiomatic for null/undefined check).
	if jsNullCheckPattern.MatchString(content) {
		clean := jsNullCheckPattern.ReplaceAllString(content, "")
		if !jsLooseEqualityPattern.MatchString(clean) {
			return ""
		}
	}
	return "`==` used instead of `===` — prefer strict equality to avoid type coercion"
}

// --- JS/TS: async function without await ---

var jsAsyncFuncStart = regexp.MustCompile(`async\s+function\s+\w+\s*\([^)]*\)\s*\{`)

func checkJSAsyncNoAwait(_, content string) string {
	locs := jsAsyncFuncStart.FindAllStringIndex(content, 3)
	for _, loc := range locs {
		// Find the opening brace and extract body via brace tracking.
		braceStart := strings.IndexByte(content[loc[0]:], '{')
		if braceStart < 0 {
			continue
		}
		bodyStart := loc[0] + braceStart + 1
		depth := 1
		bodyEnd := bodyStart
		for i := bodyStart; i < len(content) && depth > 0; i++ {
			switch content[i] {
			case '{':
				depth++
			case '}':
				depth--
			}
			bodyEnd = i
		}
		if depth != 0 || bodyEnd-bodyStart < 10 {
			continue
		}
		body := content[bodyStart:bodyEnd]
		if !strings.Contains(body, "await") {
			return "`async function` without `await` — function may not need to be async"
		}
	}
	return ""
}

// --- SQL injection via string concatenation ---

var sqlInjectionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(SELECT|INSERT|UPDATE|DELETE|DROP)\s+.*["']\s*\+\s*\w`),
	regexp.MustCompile(`(?i)(SELECT|INSERT|UPDATE|DELETE|DROP)\s+.*\$\{`),
	regexp.MustCompile(`(?i)(SELECT|INSERT|UPDATE|DELETE|DROP)\s+.*%s`),
	regexp.MustCompile(`(?i)f["'].*?(SELECT|INSERT|UPDATE|DELETE|DROP)\s+.*\{`),
}

func checkSQLInjection(_, content string) string {
	for _, p := range sqlInjectionPatterns {
		if p.MatchString(content) {
			return "Potential SQL injection — use parameterized queries instead of string concatenation"
		}
	}
	return ""
}

// --- Large function (>80 lines) ---

// checkLargeFunction detects individual functions exceeding 80 lines by tracking
// brace depth from `func` keywords.
func checkLargeFunction(_, content string) string {
	lines := strings.Split(content, "\n")
	inFunc := false
	funcStart := 0
	braceDepth := 0

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)

		if !inFunc {
			if strings.HasPrefix(trimmed, "func ") || strings.HasPrefix(trimmed, "func(") {
				inFunc = true
				funcStart = i
				braceDepth = 0
			}
		}

		if inFunc {
			braceDepth += strings.Count(line, "{") - strings.Count(line, "}")
			if braceDepth <= 0 && i > funcStart {
				funcLen := i - funcStart + 1
				if funcLen > 80 {
					return fmt.Sprintf("Function starting at line %d is %d lines — consider extracting into smaller functions", funcStart+1, funcLen)
				}
				inFunc = false
			}
		}
	}
	return ""
}

// --- Helpers ---

// extractWriteContent extracts the new content from Edit or Write tool input.
func extractWriteContent(toolInput json.RawMessage) string {
	var edit struct {
		NewString string `json:"new_string"`
	}
	if json.Unmarshal(toolInput, &edit) == nil && edit.NewString != "" {
		return edit.NewString
	}
	var write struct {
		Content string `json:"content"`
	}
	if json.Unmarshal(toolInput, &write) == nil && write.Content != "" {
		return write.Content
	}
	return ""
}

// fileExtFromPath returns the file extension without the dot.
func fileExtFromPath(path string) string {
	ext := filepath.Ext(path)
	if ext == "" {
		return ""
	}
	ext = ext[1:] // remove leading dot
	switch ext {
	case "tsx", "jsx":
		return "js"
	case "ts":
		return "js"
	}
	return ext
}
