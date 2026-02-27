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
	{Name: "rs_unwrap", Language: "rs", Check: checkRustUnwrap},
	{Name: "rs_todo_macro", Language: "rs", Check: checkRustTodoMacro},
	{Name: "rs_unsafe_no_comment", Language: "rs", Check: checkRustUnsafeNoComment},
	{Name: "hardcoded_secret", Language: "", Check: checkHardcodedSecret},
	{Name: "sql_injection", Language: "", Check: checkSQLInjection},
	{Name: "command_injection", Language: "", Check: checkCommandInjection},
	{Name: "weak_crypto", Language: "", Check: checkWeakCrypto},
	{Name: "large_function", Language: "go", Check: checkLargeFunction},
	// Security: SSRF, path traversal, regex DoS, unsafe deserialization
	{Name: "ssrf", Language: "", Check: checkSSRF},
	{Name: "path_traversal", Language: "", Check: checkPathTraversal},
	{Name: "regex_dos", Language: "", Check: checkRegexDoS},
	{Name: "unsafe_deserialization", Language: "", Check: checkUnsafeDeserialization},
	// Go: resource leak, context.Background misuse
	{Name: "go_unclosed_resource", Language: "go", Check: checkGoUnclosedResource},
	{Name: "go_context_background", Language: "go", Check: checkGoContextBackground},
	// Python: print in non-test, pickle untrusted, f-string injection
	{Name: "py_print_debug", Language: "py", Check: checkPyPrintDebug},
	{Name: "py_pickle_untrusted", Language: "py", Check: checkPyPickleUntrusted},
	// JS/TS: floating promise, unhandled rejection
	{Name: "js_floating_promise", Language: "js", Check: checkJSFloatingPromise},
	// Rust: panic outside test
	{Name: "rs_panic_outside_test", Language: "rs", Check: checkRustPanicOutsideTest},
}

// sharedMultiAnalyzer is the multi-language CodeAnalyzer singleton.
var sharedMultiAnalyzer = NewMultiAnalyzer()

// runCodeHeuristics checks edited/written content against code quality patterns.
// Returns an observation string, or "" if no issues found.
// First tries CodeAnalyzer (AST-backed for Go, enhanced regex for Python/JS/Rust),
// then falls back to regex heuristics for issues CodeAnalyzer doesn't cover.
func runCodeHeuristics(filePath string, toolInput json.RawMessage) string {
	ext := fileExtFromPath(filePath)
	content := extractWriteContent(toolInput)
	if content == "" {
		return ""
	}

	// Multi-language CodeAnalyzer: try full-file analysis first.
	if isFullFileContent(toolInput) {
		if findings := sharedMultiAnalyzer.Analyze(filePath, []byte(content)); len(findings) > 0 {
			// Try to generate a concrete fix patch.
			if fixMsg := TryFix(findings[0], []byte(content)); fixMsg != "" {
				return findings[0].Message + "\n  Suggested fix: " + fixMsg
			}
			return findings[0].Message
		}
	}

	// Go files: try AST-based analysis for Write (complete file).
	// Edit provides only a snippet (new_string), which can't be parsed as a full Go file.
	if ext == "go" && isFullFileContent(toolInput) {
		if issue := GoASTCheck(filePath, content); issue != "" {
			return issue
		}
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

// --- Command injection via string concatenation ---

var commandInjectionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`os\.system\s*\(\s*["'].*\+`),
	regexp.MustCompile(`os\.popen\s*\(\s*["'].*\+`),
	regexp.MustCompile(`subprocess\.\w+\s*\(\s*["'].*\+`),
	regexp.MustCompile(`subprocess\.\w+\s*\(\s*f["']`),
	regexp.MustCompile(`exec\.Command\s*\(\s*["'].*\+`),
	regexp.MustCompile(`child_process\.\w+\s*\(\s*["'].*\+`),
	regexp.MustCompile(`(?i)\bexec\s*\(\s*["'].*\$\{`),
	regexp.MustCompile(`Runtime\.getRuntime\(\)\.exec\s*\(\s*["'].*\+`),
}

func checkCommandInjection(_, content string) string {
	for _, p := range commandInjectionPatterns {
		if p.MatchString(content) {
			return "Potential command injection — use parameterized commands or allowlisted inputs, not string concatenation"
		}
	}
	return ""
}

// --- Weak cryptographic hash ---

var weakCryptoPatterns = []*regexp.Regexp{
	regexp.MustCompile(`crypto/(md5|sha1)\b`),
	regexp.MustCompile(`hashlib\.(md5|sha1)\s*\(`),
	regexp.MustCompile(`\bMD5\.(Create|New)\b`),
	regexp.MustCompile(`\bSHA1\.(Create|New)\b`),
	regexp.MustCompile(`MessageDigest\.getInstance\(\s*["'](MD5|SHA-1)["']\s*\)`),
	regexp.MustCompile(`createHash\(\s*["'](md5|sha1)["']\s*\)`),
}

func checkWeakCrypto(_, content string) string {
	for _, p := range weakCryptoPatterns {
		if p.MatchString(content) {
			return "Weak hash algorithm (MD5/SHA1) detected — use SHA-256 or better for security-sensitive contexts"
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

// --- Security: SSRF ---

var ssrfPatterns = []*regexp.Regexp{
	regexp.MustCompile(`requests\.(get|post|put|delete|head|patch)\s*\(\s*\w`),
	regexp.MustCompile(`http\.Get\s*\(\s*\w`),
	regexp.MustCompile(`http\.Post\s*\(\s*\w`),
	regexp.MustCompile(`fetch\s*\(\s*\w`),
	regexp.MustCompile(`urllib\.request\.urlopen\s*\(\s*\w`),
	regexp.MustCompile(`HttpClient\.\w+\s*\(\s*\w`),
}

func checkSSRF(_, content string) string {
	for _, p := range ssrfPatterns {
		if p.MatchString(content) {
			return "Potential SSRF — HTTP request with variable URL. Validate/allowlist URLs before making requests"
		}
	}
	return ""
}

// --- Security: Path traversal ---

var pathTraversalPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(open|read_?file|write_?file)\s*\(\s*["']?.*\+\s*\w`),
	regexp.MustCompile(`os\.path\.join\s*\(.*,\s*\w+\s*\)`),
	regexp.MustCompile(`filepath\.Join\s*\(.*,\s*\w+\s*\)`),
	regexp.MustCompile(`Path\s*\(\s*\w+\s*\)`),
}

func checkPathTraversal(_, content string) string {
	for _, p := range pathTraversalPatterns {
		if p.MatchString(content) {
			if strings.Contains(content, "sanitize") || strings.Contains(content, "Clean") ||
				strings.Contains(content, "filepath.Abs") || strings.Contains(content, "os.path.abspath") {
				return ""
			}
			return "Potential path traversal — validate file paths against directory traversal (../) before use"
		}
	}
	return ""
}

// --- Security: Regex DoS ---

var regexDoSPattern = regexp.MustCompile(`(?:\([^)]*[+*]\)[+*]|\([^)]*\|[^)]*\)[+*]{2})`)

func checkRegexDoS(_, content string) string {
	if !strings.Contains(content, "Compile") && !strings.Contains(content, "re.") &&
		!strings.Contains(content, "new RegExp") && !strings.Contains(content, "regex") {
		return ""
	}
	if regexDoSPattern.MatchString(content) {
		return "Potential ReDoS — nested quantifiers `(a+)+` cause catastrophic backtracking. Simplify or use RE2/linear-time engine"
	}
	return ""
}

// --- Security: Unsafe deserialization ---

var unsafeDeserializationPatterns = []*regexp.Regexp{
	regexp.MustCompile(`pickle\.loads?\s*\(`),
	regexp.MustCompile(`yaml\.load\s*\([^)]*\)(?:.*Loader)?`),
	regexp.MustCompile(`marshal\.Unmarshal\s*\(\s*\w`),
	regexp.MustCompile(`ObjectInputStream\s*\(`),
	regexp.MustCompile(`unserialize\s*\(`),
}

// yaml.safe_load and yaml.load(..., Loader=SafeLoader) are safe.
var safeYAMLPattern = regexp.MustCompile(`yaml\.(safe_load|load\s*\([^)]*SafeLoader)`)

func checkUnsafeDeserialization(_, content string) string {
	for _, p := range unsafeDeserializationPatterns {
		if p.MatchString(content) {
			if safeYAMLPattern.MatchString(content) {
				continue
			}
			return "Unsafe deserialization detected — deserializing untrusted data can lead to remote code execution"
		}
	}
	return ""
}

// --- Go: unclosed resource ---

var goOpenResourcePattern = regexp.MustCompile(`(\w+)\s*(?:,\s*\w+\s*)?[:=]+\s*(?:os\.(?:Open|Create)|sql\.Open|net\.(?:Dial|Listen)|http\.Get)\s*\(`)

func checkGoUnclosedResource(filePath, content string) string {
	if strings.HasSuffix(filePath, "_test.go") {
		return ""
	}
	locs := goOpenResourcePattern.FindAllStringSubmatch(content, -1)
	for _, loc := range locs {
		varName := loc[1]
		// Check if the resource is closed via defer or explicit Close().
		if strings.Contains(content, varName+".Close()") || strings.Contains(content, "defer "+varName+".Close()") {
			continue
		}
		return "Opened resource (`" + varName + "`) without corresponding Close() — use `defer " + varName + ".Close()` after error check"
	}
	return ""
}

// --- Go: context.Background misuse ---

func checkGoContextBackground(filePath, content string) string {
	if strings.HasSuffix(filePath, "_test.go") {
		return ""
	}
	if !strings.Contains(content, "context.Background()") {
		return ""
	}
	// Allow in main() and init().
	if strings.Contains(content, "func main()") || strings.Contains(content, "func init()") {
		return ""
	}
	// context.Background without timeout is suspicious in non-main code.
	if !strings.Contains(content, "WithTimeout") && !strings.Contains(content, "WithDeadline") &&
		!strings.Contains(content, "WithCancel") {
		return "`context.Background()` without timeout/deadline — use `context.WithTimeout` for bounded operations"
	}
	return ""
}

// --- Python: print in non-test ---

var pyPrintPattern = regexp.MustCompile(`\bprint\s*\(`)

func checkPyPrintDebug(filePath, content string) string {
	if strings.Contains(filePath, "test") || strings.Contains(filePath, "__main__") {
		return ""
	}
	if !pyPrintPattern.MatchString(content) {
		return ""
	}
	return "`print()` in non-test code — use `logging` module for production output"
}

// --- Python: pickle untrusted data ---

var pyPicklePattern = regexp.MustCompile(`pickle\.loads?\s*\(`)

func checkPyPickleUntrusted(_, content string) string {
	if !pyPicklePattern.MatchString(content) {
		return ""
	}
	return "`pickle.load()` can execute arbitrary code — use `json` or a safe serialization format for untrusted data"
}

// --- JS/TS: floating promise ---

// Detects patterns like `someAsyncFunc()` on its own line without await, .then, .catch, or assignment.
var jsFloatingPromisePattern = regexp.MustCompile(`(?m)^\s*\w+\([^)]*\)\s*;?\s*$`)

func checkJSFloatingPromise(filePath, content string) string {
	base := filepath.Base(filePath)
	if strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") {
		return ""
	}
	// Only flag if the file has async patterns.
	if !strings.Contains(content, "async") && !strings.Contains(content, "Promise") {
		return ""
	}
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !jsFloatingPromisePattern.MatchString(line) {
			continue
		}
		// Skip lines that are already handled.
		if strings.Contains(trimmed, "await") || strings.Contains(trimmed, ".then") ||
			strings.Contains(trimmed, ".catch") || strings.Contains(trimmed, "=") ||
			strings.Contains(trimmed, "return") || strings.HasPrefix(trimmed, "//") ||
			strings.HasPrefix(trimmed, "/*") || strings.HasPrefix(trimmed, "void ") {
			continue
		}
		// Likely a floating promise.
		return "Possible floating Promise — add `await`, `.catch()`, or `void` to explicitly handle or ignore the result"
	}
	return ""
}

// --- Rust: panic!() outside test ---

var rustPanicPattern = regexp.MustCompile(`\bpanic!\s*\(`)

func checkRustPanicOutsideTest(filePath, content string) string {
	if strings.HasSuffix(filePath, "_test.rs") || strings.Contains(content, "#[cfg(test)]") {
		return ""
	}
	if !rustPanicPattern.MatchString(content) {
		return ""
	}
	return "`panic!()` in non-test code — return `Result` instead, or use `unreachable!()` for truly impossible cases"
}

// --- Helpers ---

// isFullFileContent returns true if the tool input is a Write (complete file),
// not an Edit (snippet). AST analysis requires a complete Go source file.
func isFullFileContent(toolInput json.RawMessage) bool {
	var write struct {
		Content string `json:"content"`
	}
	return json.Unmarshal(toolInput, &write) == nil && write.Content != ""
}

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
	case "tsx", "jsx", "ts":
		return "js"
	case "rust":
		return "rs"
	}
	return ext
}
