package analyzer

import "strings"

// FeedbackLevel indicates the severity/importance of feedback.
type FeedbackLevel int

const (
	LevelInfo    FeedbackLevel = iota // general observation
	LevelInsight                      // non-obvious finding
	LevelWarning                      // potential issue
	LevelAction                       // requires immediate action
)

// Feedback is the LLM's evaluation of the user's Claude Code usage.
type Feedback struct {
	Situation   string        // what the user is currently doing
	Observation string        // what the buddy noticed
	Suggestion  string        // concrete action proposal
	Level       FeedbackLevel
}

// ParseLevel converts a string to FeedbackLevel.
func ParseLevel(s string) FeedbackLevel {
	switch strings.TrimSpace(strings.ToLower(s)) {
	case "insight":
		return LevelInsight
	case "warning":
		return LevelWarning
	case "action":
		return LevelAction
	default:
		return LevelInfo
	}
}
