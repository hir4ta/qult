package hookhandler

import (
	"path/filepath"
	"strings"
)

// CodeFix represents an auto-generated fix for a code quality finding.
type CodeFix struct {
	Finding     Finding
	Before      string  // original code snippet
	After       string  // fixed code snippet
	Confidence  float64 // [0.5, 1.0] — higher means safer
	Explanation string  // human-readable why this fix is suggested
}

// CodeFixer generates concrete fix patches for findings.
type CodeFixer interface {
	// Fix attempts to generate a patch for the given finding.
	// Returns nil if no fix is available.
	Fix(finding Finding, content []byte) *CodeFix
}

var fixerRegistry = map[string]CodeFixer{
	"go": &goFixer{},
	"py": &pythonFixer{},
	"js": &jsFixer{},
}

// GetFixer returns the CodeFixer for the given file path, or nil.
func GetFixer(filePath string) CodeFixer {
	ext := filepath.Ext(filePath)
	if ext != "" {
		ext = ext[1:]
	}
	switch strings.ToLower(ext) {
	case "tsx", "jsx", "ts":
		ext = "js"
	}
	return fixerRegistry[ext]
}

// TryFix runs the fixer for the file and returns a formatted suggestion, or "".
func TryFix(finding Finding, content []byte) string {
	fixer := GetFixer(finding.File)
	if fixer == nil {
		return ""
	}
	fix := fixer.Fix(finding, content)
	if fix == nil {
		return ""
	}
	return formatCodeFix(fix)
}

// formatCodeFix formats a CodeFix into a human-readable suggestion string.
func formatCodeFix(fix *CodeFix) string {
	var b strings.Builder
	b.WriteString(fix.Explanation)
	if fix.Before != "" && fix.After != "" {
		b.WriteString("\n  Before: ")
		b.WriteString(truncate(fix.Before, 120))
		b.WriteString("\n  After:  ")
		b.WriteString(truncate(fix.After, 120))
	}
	return b.String()
}

func truncate(s string, maxRunes int) string {
	r := []rune(s)
	// Collapse to single line for display.
	out := strings.ReplaceAll(string(r), "\n", " ⏎ ")
	r = []rune(out)
	if len(r) > maxRunes {
		return string(r[:maxRunes]) + "..."
	}
	return string(r)
}
