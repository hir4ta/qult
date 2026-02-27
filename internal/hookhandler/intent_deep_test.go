package hookhandler

import "testing"

func TestDetectDomain(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		prompt string
		want   string
	}{
		{"auth", "fix the login token validation", "auth"},
		{"database", "optimize the SQL query for users table", "database"},
		{"ui", "fix the button layout in modal", "ui"},
		{"api", "add a new REST endpoint for users", "api"},
		{"config", "update the environment settings", "config"},
		{"infra", "fix the docker deployment pipeline", "infra"},
		{"test", "add test coverage for parser", "test"},
		{"general", "make this better", "general"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := detectDomain(tt.prompt)
			if got != tt.want {
				t.Errorf("detectDomain(%q) = %q, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}

func TestInferImplicitGoal(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		prompt     string
		domain     string
		wantGoal   string
		wantNil    bool
		minConfid  float64
	}{
		{
			name:      "nil sdb still matches prompt cues",
			prompt:    "make it faster",
			domain:    "general",
			wantGoal:  "profiling",
			minConfid: 0.6,
		},
		{
			name:     "empty prompt returns nil",
			prompt:   "",
			domain:   "general",
			wantNil:  true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := inferImplicitGoal(nil, tt.prompt, tt.domain)
			if tt.wantNil {
				if got != nil {
					t.Errorf("inferImplicitGoal(nil, %q, %q) = %+v, want nil", tt.prompt, tt.domain, got)
				}
				return
			}
			if got == nil {
				t.Fatalf("inferImplicitGoal(nil, %q, %q) = nil, want goal=%q", tt.prompt, tt.domain, tt.wantGoal)
			}
			if got.Goal != tt.wantGoal {
				t.Errorf("goal = %q, want %q", got.Goal, tt.wantGoal)
			}
			if got.Confidence < tt.minConfid {
				t.Errorf("confidence = %v, want >= %v", got.Confidence, tt.minConfid)
			}
		})
	}
}

func TestInferImplicitGoal_PromptCues(t *testing.T) {
	t.Parallel()

	// Test with non-nil but minimal setup: we just test the prompt cue matching
	// by calling inferImplicitGoalDirect which only needs prompt and domain.
	tests := []struct {
		name     string
		prompt   string
		domain   string
		wantGoal string
	}{
		{"performance general", "make this faster", "general", "profiling"},
		{"performance database", "make queries faster", "database", "indexing"},
		{"performance api", "reduce latency of api calls", "api", "latency_optimization"},
		{"caching", "add cache for this computation", "general", "caching"},
		{"cleanup", "clean up dead code and unused imports", "general", "cleanup"},
		{"refactor", "simplify this module structure", "general", "refactor"},
		{"refactor test", "simplify the test setup", "test", "test_refactor"},
		{"security", "fix xss vulnerability in form", "general", "security"},
		{"scaling", "make this handle concurrent requests", "general", "scaling"},
		{"no match", "hello world", "general", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := inferImplicitGoal(nil, tt.prompt, tt.domain)
			if tt.wantGoal == "" {
				if got != nil {
					t.Errorf("inferImplicitGoal(nil, %q, %q) = %+v, want nil", tt.prompt, tt.domain, got)
				}
				return
			}
			if got == nil {
				t.Fatalf("inferImplicitGoal(nil, %q, %q) = nil, want goal=%q", tt.prompt, tt.domain, tt.wantGoal)
			}
			if got.Goal != tt.wantGoal {
				t.Errorf("goal = %q, want %q", got.Goal, tt.wantGoal)
			}
			if len(got.Signals) == 0 {
				t.Error("signals should not be empty")
			}
		})
	}
}
