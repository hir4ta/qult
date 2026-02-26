package hookhandler

import (
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
	return &multiAnalyzer{
		analyzers: map[string]CodeAnalyzer{
			"go": NewGoAnalyzer(),
			"py": &pyAnalyzer{},
			"js": &jsAnalyzer{},
			"rs": &rsAnalyzer{},
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
		})
	}
	if pyMutableDefaultPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "py-mutable-default",
			Message:  "Mutable default argument `[]` — use `None` and assign inside the function body",
		})
	}
	if pyStarImportPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "py-star-import",
			Message:  "`from module import *` pollutes namespace — import specific names",
		})
	}
	if pyDictDefaultPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "py-mutable-default-dict",
			Message:  "Mutable default argument `{}` — use `None` and assign inside the function body",
		})
	}
	return findings
}

func (p *pyAnalyzer) SupportedLanguages() []string { return []string{"py"} }

// Additional Python pattern.
var pyDictDefaultPattern = regexp.MustCompile(`def\s+\w+\s*\([^)]*=\s*\{\s*\}`)

// --- JS/TS analyzer ---

type jsAnalyzer struct{}

func (j *jsAnalyzer) Analyze(filePath string, content []byte) []Finding {
	base := filepath.Base(filePath)
	isTest := strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") || strings.Contains(base, "_test.")
	src := string(content)
	var findings []Finding

	if !isTest && jsConsoleLogPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "js-console-log",
			Message:  "console.log detected — remove debug logs before committing",
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
			})
		}
	}
	if jsUnusedImportPattern.MatchString(src) {
		findings = append(findings, findUnusedImports(filePath, src)...)
	}
	return findings
}

func (j *jsAnalyzer) SupportedLanguages() []string { return []string{"js"} }

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
		})
	}
	if !isTest && rsTodoPattern.MatchString(src) {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "warning",
			Rule:     "rs-todo-macro",
			Message:  "`todo!()` macro in non-test code — will panic at runtime",
		})
	}
	if rsUnsafePattern.MatchString(src) {
		// Check if unsafe block has a SAFETY comment nearby.
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
				})
				break
			}
		}
	}
	return findings
}

func (r *rsAnalyzer) SupportedLanguages() []string { return []string{"rs"} }

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
