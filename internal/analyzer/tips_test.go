package analyzer

import "testing"

func TestParseLevel(t *testing.T) {
	tests := []struct {
		input string
		want  FeedbackLevel
	}{
		{"low", LevelLow},
		{"LOW", LevelLow},
		{"info", LevelInfo},
		{"INFO", LevelInfo},
		{"  info  ", LevelInfo},
		{"insight", LevelInsight},
		{"INSIGHT", LevelInsight},
		{"warning", LevelWarning},
		{"Warning", LevelWarning},
		{"action", LevelAction},
		{"ACTION", LevelAction},
		{"", LevelLow},
		{"unknown", LevelLow},
		{"  Action  ", LevelAction},
	}
	for _, tt := range tests {
		got := ParseLevel(tt.input)
		if got != tt.want {
			t.Errorf("ParseLevel(%q) = %d, want %d", tt.input, got, tt.want)
		}
	}
}
