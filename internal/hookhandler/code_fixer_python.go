package hookhandler

import (
	"regexp"
	"strings"
)

// pythonFixer generates patches for Python code quality findings.
type pythonFixer struct{}

func (p *pythonFixer) Fix(finding Finding, content []byte) *CodeFix {
	switch {
	case finding.Rule == "py_bare_except" || strings.Contains(finding.Message, "bare `except:`"):
		return p.fixBareExcept(finding, content)
	case finding.Rule == "py_mutable_default" || strings.Contains(finding.Message, "mutable default"):
		return p.fixMutableDefault(finding, content)
	case finding.Rule == "py_broad_exception" || strings.Contains(finding.Message, "broad exception"):
		return p.fixBroadException(finding, content)
	case finding.Rule == "py_star_import" || strings.Contains(finding.Message, "star import"):
		return p.fixStarImport(finding, content)
	}
	return nil
}

// fixBareExcept changes `except:` to `except Exception:`.
var bareExceptPattern = regexp.MustCompile(`(\s*)except\s*:`)

func (p *pythonFixer) fixBareExcept(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" {
		return nil
	}
	if !bareExceptPattern.MatchString(line) {
		return nil
	}
	before := strings.TrimSpace(line)
	after := bareExceptPattern.ReplaceAllString(line, "${1}except Exception:")
	after = strings.TrimSpace(after)

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.9,
		Explanation: "Catch specific exceptions — bare `except:` also catches SystemExit and KeyboardInterrupt",
	}
}

// fixMutableDefault changes `def f(x=[])` to `def f(x=None)` with body guard.
var mutableDefaultPattern = regexp.MustCompile(`(\w+)\s*=\s*(\[\]|\{\})`)

func (p *pythonFixer) fixMutableDefault(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" || !strings.Contains(line, "def ") {
		return nil
	}

	loc := mutableDefaultPattern.FindStringSubmatchIndex(line)
	if loc == nil || len(loc) < 6 {
		return nil
	}
	before := strings.TrimSpace(line)

	paramName := line[loc[2]:loc[3]]
	mutableVal := line[loc[4]:loc[5]]
	after := strings.Replace(before, paramName+"="+mutableVal, paramName+"=None", 1)

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.85,
		Explanation: "Mutable defaults are shared across calls — use None and create in body: `if x is None: x = " + mutableVal + "`",
	}
}

// fixBroadException suggests narrowing `except Exception` to specific types.
// Does NOT suggest concrete types since the correct types depend on the try block.
func (p *pythonFixer) fixBroadException(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" {
		return nil
	}
	before := strings.TrimSpace(line)

	// Extract the variable name if present (e.g., "except Exception as e").
	asName := ""
	if _, after, ok := strings.Cut(before, " as "); ok {
		asName = strings.TrimSuffix(strings.TrimSpace(after), ":")
	}

	after := "except (<SpecificError1>, <SpecificError2>)"
	if asName != "" {
		after += " as " + asName
	}
	after += ":"

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.35, // low: correct types depend on the try block content
		Explanation: "Catching broad `Exception` masks bugs — narrow to specific types raised by the try block",
	}
}

// fixStarImport suggests explicit imports.
var starImportPattern = regexp.MustCompile(`from\s+(\S+)\s+import\s+\*`)

func (p *pythonFixer) fixStarImport(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" {
		return nil
	}
	loc := starImportPattern.FindStringSubmatch(line)
	if loc == nil {
		return nil
	}
	before := strings.TrimSpace(line)
	after := "from " + loc[1] + " import specific_name  # list needed names explicitly"

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.7,
		Explanation: "Star imports pollute namespace and hide where names come from",
	}
}
