package hookhandler

import "testing"

func TestClassifyIntent(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		prompt string
		want   TaskType
	}{
		{"bugfix", "fix the login error", TaskBugfix},
		{"feature", "add a new export button", TaskFeature},
		{"refactor", "refactor the auth module", TaskRefactor},
		{"test", "add test coverage for parser", TaskTest},
		{"unknown", "hello", TaskUnknown},
		{"empty", "", TaskUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := classifyIntent(tt.prompt)
			if got != tt.want {
				t.Errorf("classifyIntent(%q) = %q, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}

