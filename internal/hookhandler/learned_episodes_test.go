package hookhandler

import "testing"

func TestMatchSubsequence(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		source []string
		target []string
		want   int
	}{
		{"full match", []string{"A", "B", "C"}, []string{"A", "B", "C"}, 3},
		{"partial match", []string{"A", "X", "B", "Y", "C"}, []string{"A", "B", "C"}, 3},
		{"no match", []string{"X", "Y", "Z"}, []string{"A", "B", "C"}, 0},
		{"partial only", []string{"A", "B"}, []string{"A", "B", "C"}, 2},
		{"empty source", []string{}, []string{"A", "B"}, 0},
		{"empty target", []string{"A", "B"}, []string{}, 0},
		{"case insensitive", []string{"read", "Edit"}, []string{"Read", "edit"}, 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := matchSubsequence(tt.source, tt.target)
			if got != tt.want {
				t.Errorf("matchSubsequence(%v, %v) = %d, want %d", tt.source, tt.target, got, tt.want)
			}
		})
	}
}

func TestToolToPhase(t *testing.T) {
	t.Parallel()
	tests := []struct {
		tool string
		want string
	}{
		{"Read", "read"},
		{"Glob", "read"},
		{"Grep", "read"},
		{"Edit", "write"},
		{"Write", "write"},
		{"Bash", "test"},
		{"EnterPlanMode", "plan"},
		{"Task", "delegate"},
		{"Unknown", ""},
	}
	for _, tt := range tests {
		t.Run(tt.tool, func(t *testing.T) {
			t.Parallel()
			got := toolToPhase(tt.tool)
			if got != tt.want {
				t.Errorf("toolToPhase(%q) = %q, want %q", tt.tool, got, tt.want)
			}
		})
	}
}

func TestExtractFailureSequence(t *testing.T) {
	t.Parallel()

	t.Run("returns nil for short events", func(t *testing.T) {
		t.Parallel()
		got := extractFailureSequence(nil)
		if got != nil {
			t.Errorf("got %v, want nil", got)
		}
	})
}
