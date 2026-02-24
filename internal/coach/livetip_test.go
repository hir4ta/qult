package coach

import (
	"testing"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
)

func TestParseFeedbackOutput(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  analyzer.Feedback
	}{
		{
			name: "full output",
			input: `SITUATION: Implementing REST API endpoints
OBSERVATION: No tests written after 10 turns. Bash grep used 3 times instead of Grep tool.
SUGGESTION: Run go test ./... before proceeding to catch regressions early
LEVEL: warning`,
			want: analyzer.Feedback{
				Situation:   "Implementing REST API endpoints",
				Observation: "No tests written after 10 turns. Bash grep used 3 times instead of Grep tool.",
				Suggestion:  "Run go test ./... before proceeding to catch regressions early",
				Level:       analyzer.LevelWarning,
			},
		},
		{
			name: "partial output - missing LEVEL",
			input: `SITUATION: Refactoring auth module
OBSERVATION: Good use of Plan Mode for complex changes
SUGGESTION: Add CLAUDE.md rules for the new module structure`,
			want: analyzer.Feedback{
				Situation:   "Refactoring auth module",
				Observation: "Good use of Plan Mode for complex changes",
				Suggestion:  "Add CLAUDE.md rules for the new module structure",
				Level:       analyzer.LevelLow,
			},
		},
		{
			name: "partial output - only SUGGESTION",
			input: `SUGGESTION: Use /compact to free up context`,
			want: analyzer.Feedback{
				Situation:   "Analyzing session...",
				Observation: "Gathering session data",
				Suggestion:  "Use /compact to free up context",
				Level:       analyzer.LevelLow,
			},
		},
		{
			name:  "empty input",
			input: "",
			want: analyzer.Feedback{
				Situation:   "Analyzing session...",
				Observation: "Gathering session data",
				Suggestion:  "Include specific file paths in your instructions for better accuracy",
				Level:       analyzer.LevelLow,
			},
		},
		{
			name:  "garbage input",
			input: "This is not in the expected format at all.",
			want: analyzer.Feedback{
				Situation:   "Analyzing session...",
				Observation: "Gathering session data",
				Suggestion:  "Include specific file paths in your instructions for better accuracy",
				Level:       analyzer.LevelLow,
			},
		},
		{
			name: "level action",
			input: `SITUATION: Long session without compaction
OBSERVATION: 50+ turns, context likely degraded
SUGGESTION: Run /compact immediately
LEVEL: action`,
			want: analyzer.Feedback{
				Situation:   "Long session without compaction",
				Observation: "50+ turns, context likely degraded",
				Suggestion:  "Run /compact immediately",
				Level:       analyzer.LevelAction,
			},
		},
		{
			name: "level insight",
			input: `SITUATION: Building UI components
OBSERVATION: Consistent use of subagents for parallel research
SUGGESTION: Consider adding .claude/agents/ for custom agent definitions
LEVEL: insight`,
			want: analyzer.Feedback{
				Situation:   "Building UI components",
				Observation: "Consistent use of subagents for parallel research",
				Suggestion:  "Consider adding .claude/agents/ for custom agent definitions",
				Level:       analyzer.LevelInsight,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseFeedbackOutput(tt.input)
			if got.Situation != tt.want.Situation {
				t.Errorf("Situation = %q, want %q", got.Situation, tt.want.Situation)
			}
			if got.Observation != tt.want.Observation {
				t.Errorf("Observation = %q, want %q", got.Observation, tt.want.Observation)
			}
			if got.Suggestion != tt.want.Suggestion {
				t.Errorf("Suggestion = %q, want %q", got.Suggestion, tt.want.Suggestion)
			}
			if got.Level != tt.want.Level {
				t.Errorf("Level = %d, want %d", got.Level, tt.want.Level)
			}
		})
	}
}
