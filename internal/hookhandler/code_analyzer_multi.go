package hookhandler

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// multiAnalyzer dispatches to language-specific CodeAnalyzers.
type multiAnalyzer struct {
	analyzers map[string]CodeAnalyzer
}

// NewMultiAnalyzer creates a CodeAnalyzer that delegates to per-language analyzers.
func NewMultiAnalyzer() CodeAnalyzer {
	js := &jsAnalyzer{}
	return &multiAnalyzer{
		analyzers: map[string]CodeAnalyzer{
			"go":  NewGoAnalyzer(),
			"py":  &pyAnalyzer{},
			"js":  js,
			"ts":  js, // TypeScript shares JS analyzer with extra checks
			"tsx": js,
			"jsx": js,
			"rs":  &rsAnalyzer{},
		},
	}
}

func (m *multiAnalyzer) Analyze(filePath string, content []byte) []Finding {
	ext := fileExtFromPath(filePath)
	if a, ok := m.analyzers[ext]; ok {
		return a.Analyze(filePath, content)
	}
	return nil
}

func (m *multiAnalyzer) SupportedLanguages() []string {
	langs := make([]string, 0, len(m.analyzers))
	for lang := range m.analyzers {
		langs = append(langs, lang)
	}
	return langs
}

// --- Python analyzer ---

type pyAnalyzer struct{}

func (p *pyAnalyzer) Analyze(filePath string, content []byte) []Finding {
	src := string(content)
	var findings []Finding

	if pyBareExceptPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "py-bare-except",
			Message:  "Bare `except:` catches all exceptions including KeyboardInterrupt — specify the exception type",
			Category: "error_handling",
		})
	}
	if pyBroadExceptPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "info",
			Rule:     "py-broad-exception",
			Message:  "`except Exception` is very broad — consider catching specific exception types",
			Category: "error_handling",
		})
	}
	if pyMutableDefaultPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "py-mutable-default",
			Message:  "Mutable default argument `[]` — use `None` and assign inside the function body",
			Category: "style",
		})
	}
	if pyStarImportPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "py-star-import",
			Message:  "`from module import *` pollutes namespace — import specific names",
			Category: "style",
		})
	}
	if pyDictDefaultPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "py-mutable-default-dict",
			Message:  "Mutable default argument `{}` — use `None` and assign inside the function body",
			Category: "style",
		})
	}
	if pyAssertInProdPattern.MatchString(src) && !strings.Contains(filePath, "test") {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "info",
			Rule:     "py-assert-in-prod",
			Message:  "`assert` in non-test code — stripped with `python -O`, use explicit checks",
			Category: "error_handling",
		})
	}

	// Cognitive complexity estimate.
	if cc := estimateCognitiveComplexity(src); cc > 15 {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "info",
			Rule:     "complexity",
			Message:  fmt.Sprintf("Estimated cognitive complexity: %d (high) — consider breaking into smaller functions", cc),
			Category: "complexity",
		})
	}

	return findings
}

func (p *pyAnalyzer) SupportedLanguages() []string { return []string{"py"} }

// Additional Python patterns.
var (
	pyDictDefaultPattern  = regexp.MustCompile(`def\s+\w+\s*\([^)]*=\s*\{\s*\}`)
	pyBroadExceptPattern  = regexp.MustCompile(`except\s+Exception\s*:`)
	pyAssertInProdPattern = regexp.MustCompile(`(?m)^\s*assert\s+`)
)

// --- JS/TS analyzer ---

type jsAnalyzer struct{}

func (j *jsAnalyzer) Analyze(filePath string, content []byte) []Finding {
	base := filepath.Base(filePath)
	ext := fileExtFromPath(filePath)
	isTest := strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") || strings.Contains(base, "_test.")
	isTS := ext == "ts" || ext == "tsx"
	src := string(content)
	var findings []Finding

	if !isTest && jsConsoleLogPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "js-console-log",
			Message:  "console.log detected — remove debug logs before committing",
			Category: "style",
		})
	}
	if !isTest && jsLooseEqualityPattern.MatchString(src) {
		clean := jsNullCheckPattern.ReplaceAllString(src, "")
		if jsLooseEqualityPattern.MatchString(clean) {
			findings = append(findings, Finding{
				File:     filePath,
				Severity: "warning",
				Rule:     "js-loose-equality",
				Message:  "`==` used instead of `===` — prefer strict equality to avoid type coercion",
				Category: "style",
			})
		}
	}
	if jsUnusedImportPattern.MatchString(src) {
		findings = append(findings, findUnusedImports(filePath, src)...)
	}

	// TypeScript-specific checks.
	if isTS {
		if tsAnyTypePattern.MatchString(src) {
			findings = append(findings, Finding{
				File:     filePath,
				Severity: "info",
				Rule:     "ts-any-type",
				Message:  "`any` type weakens type safety — use `unknown` or a specific type",
				Category: "style",
			})
		}
		if hasAsyncWithoutAwait(src) {
			findings = append(findings, Finding{
				File:     filePath,
				Severity: "warning",
				Rule:     "ts-async-no-await",
				Message:  "`async` function without `await` — remove `async` or add awaited calls",
				Category: "error_handling",
			})
		}
	}

	// Cognitive complexity estimate.
	if cc := estimateCognitiveComplexity(src); cc > 15 {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "info",
			Rule:     "complexity",
			Message:  fmt.Sprintf("Estimated cognitive complexity: %d (high) — consider breaking into smaller functions", cc),
			Category: "complexity",
		})
	}

	return findings
}

func (j *jsAnalyzer) SupportedLanguages() []string { return []string{"js", "ts", "tsx", "jsx"} }

// TypeScript patterns.
var (
	tsAnyTypePattern      = regexp.MustCompile(`:\s*any\b`)
	tsAsyncFuncPattern    = regexp.MustCompile(`async\s+(?:function\s+\w+|(?:\w+|\([^)]*\))\s*=>)`)
)

// hasAsyncWithoutAwait uses brace counting to extract async function bodies
// and checks if any body lacks an await keyword.
func hasAsyncWithoutAwait(src string) bool {
	locs := tsAsyncFuncPattern.FindAllStringIndex(src, -1)
	for _, loc := range locs {
		// Find the opening brace after the async declaration.
		rest := src[loc[1]:]
		braceIdx := strings.Index(rest, "{")
		if braceIdx < 0 {
			continue
		}
		// Extract the function body via brace counting.
		bodyStart := loc[1] + braceIdx
		depth := 0
		bodyEnd := -1
		for i := bodyStart; i < len(src); i++ {
			switch src[i] {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					bodyEnd = i + 1
				}
			}
			if bodyEnd >= 0 {
				break
			}
		}
		if bodyEnd < 0 {
			continue
		}
		body := src[bodyStart:bodyEnd]
		if !strings.Contains(body, "await ") && !strings.Contains(body, "await(") {
			return true
		}
	}
	return false
}

// jsUnusedImportPattern matches ES import statements for candidate detection.
var jsUnusedImportPattern = regexp.MustCompile(`import\s+\{([^}]+)\}\s+from\s+['"]`)

// findUnusedImports checks named imports for references in the rest of the file.
func findUnusedImports(filePath, content string) []Finding {
	matches := jsUnusedImportPattern.FindAllStringSubmatchIndex(content, 10)
	var findings []Finding
	for _, m := range matches {
		if m[2] < 0 || m[3] < 0 {
			continue
		}
		names := content[m[2]:m[3]]
		importEnd := m[1]
		rest := content[importEnd:]
		for _, name := range strings.Split(names, ",") {
			name = strings.TrimSpace(name)
			// Handle "Foo as Bar" — check the alias.
			if idx := strings.Index(name, " as "); idx >= 0 {
				name = strings.TrimSpace(name[idx+4:])
			}
			if name == "" {
				continue
			}
			if !strings.Contains(rest, name) {
				findings = append(findings, Finding{
					File:     filePath,
					Severity: "info",
					Rule:     "js-unused-import",
					Message:  "Imported `" + name + "` appears unused — remove if not needed",
				})
			}
		}
	}
	return findings
}

// --- Rust analyzer ---

type rsAnalyzer struct{}

func (r *rsAnalyzer) Analyze(filePath string, content []byte) []Finding {
	isTest := strings.Contains(string(content), "#[cfg(test)]") || strings.HasSuffix(filePath, "_test.rs")
	src := string(content)
	var findings []Finding

	if !isTest && rsUnwrapPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "rs-unwrap",
			Message:  "`.unwrap()` on Result/Option — use `?` operator or handle the error explicitly",
			Category: "error_handling",
		})
	}
	if !isTest && rsTodoPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "rs-todo-macro",
			Message:  "`todo!()` macro in non-test code — will panic at runtime",
			Category: "error_handling",
		})
	}
	if rsUnsafePattern.MatchString(src) {
		locs := rsUnsafePattern.FindAllStringIndex(src, -1)
		for _, loc := range locs {
			start := max(0, loc[0]-100)
			nearby := src[start:loc[0]]
			if !strings.Contains(strings.ToUpper(nearby), "SAFETY") {
				findings = append(findings, Finding{
					File:     filePath,
					Severity: "info",
					Rule:     "rs-unsafe-no-safety",
					Message:  "`unsafe` block without `// SAFETY:` comment — document the invariants",
					Category: "security",
				})
				break
			}
		}
	}
	if !isTest && rsCloneOverusePattern.MatchString(src) {
		count := len(rsCloneOverusePattern.FindAllStringIndex(src, -1))
		if count >= 5 {
			findings = append(findings, Finding{
				File:     filePath,
				Severity: "info",
				Rule:     "rs-clone-overuse",
				Message:  fmt.Sprintf("`.clone()` used %d times — consider borrowing or using references", count),
				Category: "style",
			})
		}
	}

	// Cognitive complexity estimate.
	if cc := estimateCognitiveComplexity(src); cc > 15 {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "info",
			Rule:     "complexity",
			Message:  fmt.Sprintf("Estimated cognitive complexity: %d (high) — consider breaking into smaller functions", cc),
			Category: "complexity",
		})
	}

	return findings
}

func (r *rsAnalyzer) SupportedLanguages() []string { return []string{"rs"} }

var rsCloneOverusePattern = regexp.MustCompile(`\.clone\(\)`)

// Rust patterns.
var (
	rsUnwrapPattern = regexp.MustCompile(`\.unwrap\(\)`)
	rsTodoPattern   = regexp.MustCompile(`\btodo!\s*\(`)
	rsUnsafePattern = regexp.MustCompile(`\bunsafe\s*\{`)
)

// --- Rust heuristic check functions (for codeHeuristics table) ---

func checkRustUnwrap(filePath, content string) string {
	if strings.Contains(content, "#[cfg(test)]") || strings.HasSuffix(filePath, "_test.rs") {
		return ""
	}
	if !rsUnwrapPattern.MatchString(content) {
		return ""
	}
	return "`.unwrap()` on Result/Option — use `?` operator or handle the error explicitly"
}

func checkRustTodoMacro(filePath, content string) string {
	if strings.Contains(content, "#[cfg(test)]") || strings.HasSuffix(filePath, "_test.rs") {
		return ""
	}
	if !rsTodoPattern.MatchString(content) {
		return ""
	}
	return "`todo!()` macro in non-test code — will panic at runtime"
}

func checkRustUnsafeNoComment(_, content string) string {
	locs := rsUnsafePattern.FindAllStringIndex(content, -1)
	for _, loc := range locs {
		start := max(0, loc[0]-100)
		nearby := content[start:loc[0]]
		if !strings.Contains(strings.ToUpper(nearby), "SAFETY") {
			return "`unsafe` block without `// SAFETY:` comment — document the invariants"
		}
	}
	return ""
}

// complexityPatterns match control flow structures that increase cognitive complexity.
var complexityPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\b(if|else if|elif)\b`),
	regexp.MustCompile(`\b(for|while|loop)\b`),
	regexp.MustCompile(`\b(switch|match|case)\b`),
	regexp.MustCompile(`\b(catch|except|rescue)\b`),
	regexp.MustCompile(`\?\?|&&|\|\|`),
	regexp.MustCompile(`\?[^:]*:`), // ternary
}

// estimateCognitiveComplexity provides a regex-based estimate of cognitive complexity.
// Each nesting level and control flow structure increments the score.
// Uses brace counting for C-style languages and indentation for Python.
// This is a heuristic approximation — not a formal metric.
func estimateCognitiveComplexity(src string) int {
	useBraces := strings.Contains(src, "{")
	score := 0
	nesting := 0
	baseIndent := -1

	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "#") {
			continue
		}

		if useBraces {
			// Track nesting via braces (C-style languages).
			opens := strings.Count(trimmed, "{")
			closes := strings.Count(trimmed, "}")

			for _, pat := range complexityPatterns {
				if pat.MatchString(trimmed) {
					score += 1 + nesting
					break
				}
			}

			nesting += opens - closes
			if nesting < 0 {
				nesting = 0
			}
		} else {
			// Track nesting via indentation (Python and similar).
			indent := len(line) - len(strings.TrimLeft(line, " \t"))
			tabWidth := 4
			indent = strings.Count(line[:len(line)-len(strings.TrimLeft(line, " \t"))], "\t")*tabWidth +
				strings.Count(line[:len(line)-len(strings.TrimLeft(line, " \t"))], " ")

			if baseIndent < 0 {
				baseIndent = indent
			}
			nesting = (indent - baseIndent) / tabWidth
			if nesting < 0 {
				nesting = 0
			}

			for _, pat := range complexityPatterns {
				if pat.MatchString(trimmed) {
					score += 1 + nesting
					break
				}
			}
		}
	}
	return score
}
