package hookhandler

import (
	"regexp"
	"strings"
)

// jsFixer generates patches for JavaScript/TypeScript code quality findings.
type jsFixer struct{}

func (j *jsFixer) Fix(finding Finding, content []byte) *CodeFix {
	switch {
	case finding.Rule == "js_console_log" || strings.Contains(finding.Message, "console.log"):
		return j.fixConsoleLog(finding, content)
	case finding.Rule == "js_loose_equality" || strings.Contains(finding.Message, "loose equality"):
		return j.fixLooseEquality(finding, content)
	case finding.Rule == "js_var_usage" || strings.Contains(finding.Message, "`var`"):
		return j.fixVarUsage(finding, content)
	case finding.Rule == "js_empty_catch" || strings.Contains(finding.Message, "empty catch"):
		return j.fixEmptyCatch(finding, content)
	}
	return nil
}

// fixConsoleLog suggests deleting debug console.log statements.
func (j *jsFixer) fixConsoleLog(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" || !strings.Contains(line, "console.log") {
		return nil
	}
	before := strings.TrimSpace(line)

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       "(delete this line)",
		Confidence:  0.75,
		Explanation: "Remove debug console.log before committing — use a proper logger for production output",
	}
}

// fixLooseEquality changes `==` to `===` and `!=` to `!==`.
var (
	looseEqEqPattern  = regexp.MustCompile(`([^!=])==([^=])`)
	looseNeqPattern   = regexp.MustCompile(`([^!])!=([^=])`)
)

func (j *jsFixer) fixLooseEquality(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" {
		return nil
	}

	before := strings.TrimSpace(line)
	after := before

	after = looseEqEqPattern.ReplaceAllString(after, "${1}===${2}")
	after = looseNeqPattern.ReplaceAllString(after, "${1}!==${2}")

	if after == before {
		return nil
	}

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.85,
		Explanation: "Use strict equality (===) — loose equality (==) performs type coercion which causes subtle bugs",
	}
}

// fixVarUsage changes `var` to `const` or `let` depending on reassignment.
var varDeclPattern = regexp.MustCompile(`^(\s*)var\s+`)
var varNamePattern = regexp.MustCompile(`^var\s+(\w+)`)

func (j *jsFixer) fixVarUsage(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" || !varDeclPattern.MatchString(line) {
		return nil
	}

	before := strings.TrimSpace(line)

	// Extract variable name and check for reassignment in the rest of the content.
	replacement := "const"
	if m := varNamePattern.FindStringSubmatch(before); len(m) > 1 {
		varName := m[1]
		lines := strings.Split(string(content), "\n")
		rest := ""
		if finding.Line > 0 && finding.Line < len(lines) {
			rest = strings.Join(lines[finding.Line:], "\n")
		}
		// Check for reassignment patterns: varName =, varName++, varName--, varName +=, etc.
		// Use [^=>] to exclude == and => (arrow functions). Go RE2 has no lookahead.
		reassignPattern, err := regexp.Compile(`\b` + regexp.QuoteMeta(varName) + `\s*(\+\+|--|\+=|-=|\*=|/=|%=|&=|\|=|\^=|=[^=>])`)
		if err == nil && reassignPattern.MatchString(rest) {
			replacement = "let"
		}
	}

	after := strings.Replace(before, "var ", replacement+" ", 1)

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.8,
		Explanation: "Use `" + replacement + "` instead of `var` — var has function scope and hoisting issues",
	}
}

// fixEmptyCatch suggests logging in empty catch blocks.
var emptyCatchPattern = regexp.MustCompile(`catch\s*\(\s*(\w*)\s*\)\s*\{\s*\}`)

func (j *jsFixer) fixEmptyCatch(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" {
		return nil
	}
	before := strings.TrimSpace(line)
	if !emptyCatchPattern.MatchString(before) {
		return nil
	}

	loc := emptyCatchPattern.FindStringSubmatch(before)
	errName := "e"
	if len(loc) > 1 && loc[1] != "" {
		errName = loc[1]
	}
	after := emptyCatchPattern.ReplaceAllString(before, "catch ("+errName+") { console.error("+errName+"); }")

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.8,
		Explanation: "Empty catch blocks silently swallow errors — at minimum log the error for debugging",
	}
}
