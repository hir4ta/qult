package hookhandler

import (
	"path/filepath"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/store"
)

// CodeFix represents an auto-generated fix for a code quality finding.
type CodeFix struct {
	Finding              Finding
	Before               string  // original code snippet
	After                string  // fixed code snippet
	Confidence           float64 // [0.3, 0.95] — higher means safer
	ConfidenceAdjustment float64 // feedback-driven adjustment applied (0 if none)
	Explanation          string  // human-readable why this fix is suggested
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
	"rs": &rustFixer{},
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
// Adjusts confidence based on historical feedback for the finding's rule.
func TryFix(finding Finding, content []byte) string {
	fixer := GetFixer(finding.File)
	if fixer == nil {
		return ""
	}
	fix := fixer.Fix(finding, content)
	if fix == nil {
		return ""
	}
	adjustConfidence(fix)
	return formatCodeFix(fix)
}

// adjustConfidence modifies a fix's confidence based on historical user feedback.
// Boosts confidence for rules with high helpful rate, reduces for high misleading rate.
// No-op if the store is unavailable or has insufficient data.
func adjustConfidence(fix *CodeFix) {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	rule := fix.Finding.Rule
	if rule == "" {
		return
	}

	stats, err := st.PatternFeedbackStats("code_fix:" + rule)
	if err != nil || stats.TotalCount < 3 {
		return
	}

	// WeightedScore is in [-1, 1]. Scale to [-0.1, +0.1] adjustment.
	adjustment := stats.WeightedScore * 0.1
	fix.Confidence += adjustment
	fix.ConfidenceAdjustment = adjustment

	// Clamp to valid range.
	if fix.Confidence < 0.3 {
		fix.Confidence = 0.3
	}
	if fix.Confidence > 0.95 {
		fix.Confidence = 0.95
	}
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

// getLine returns the content of a specific line (1-indexed), or "".
func getLine(content []byte, lineNum int) string {
	if lineNum <= 0 {
		return ""
	}
	lines := strings.Split(string(content), "\n")
	if lineNum > len(lines) {
		return ""
	}
	return lines[lineNum-1]
}
