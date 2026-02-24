package mcpserver

import "github.com/hir4ta/claude-buddy/internal/analyzer"

// levelString converts a FeedbackLevel to a string label.
func levelString(l analyzer.FeedbackLevel) string {
	switch l {
	case analyzer.LevelLow:
		return "low"
	case analyzer.LevelInsight:
		return "insight"
	case analyzer.LevelWarning:
		return "warning"
	case analyzer.LevelAction:
		return "action"
	default:
		return "info"
	}
}

// truncate shortens a string to maxLen runes, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}
