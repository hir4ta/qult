package mcpserver

import (
	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

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

// alertInfo is a flattened alert for resource/prompt use.
type alertInfo struct {
	Pattern     string
	Level       string
	Observation string
	Suggestion  string
}

// findLatestSession returns the latest session from claudeHome, or nil.
func findLatestSession(claudeHome string) *watcher.SessionInfo {
	sessions, err := watcher.ListSessions(claudeHome)
	if err != nil || len(sessions) == 0 {
		return nil
	}
	return &sessions[0]
}

// computeAlertsAndScore loads a session's events, runs the detector, and returns alerts + health score.
func computeAlertsAndScore(session *watcher.SessionInfo) ([]alertInfo, float64) {
	detail, err := watcher.LoadSessionDetail(*session)
	if err != nil {
		return nil, 1.0
	}

	det := analyzer.NewDetector()
	for _, ev := range detail.Events {
		det.Update(ev)
	}

	active := det.ActiveAlerts()
	var alerts []alertInfo
	for _, a := range active {
		alerts = append(alerts, alertInfo{
			Pattern:     analyzer.PatternName(a.Pattern),
			Level:       levelString(a.Level),
			Observation: a.Observation,
			Suggestion:  a.Suggestion,
		})
	}
	return alerts, det.SessionHealth()
}
