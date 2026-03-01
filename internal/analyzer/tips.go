package analyzer

// FeedbackLevel indicates the severity/importance of feedback.
type FeedbackLevel int

const (
	LevelLow     FeedbackLevel = iota // not worth showing
	LevelInfo                         // general observation
	LevelInsight                      // non-obvious finding
	LevelWarning                      // potential issue
	LevelAction                       // requires immediate action
)

// Feedback is the LLM's evaluation of the user's Claude Code usage.
type Feedback struct {
	Situation   string        // what the user is currently doing
	Observation string        // what alfred noticed
	Suggestion  string        // concrete action proposal
	Level       FeedbackLevel
}


