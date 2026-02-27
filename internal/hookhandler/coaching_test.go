package hookhandler

import (
	"strings"
	"testing"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

func openCoachingTestDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	id := "test-coaching-" + strings.ReplaceAll(t.Name(), "/", "-")
	sdb, err := sessiondb.Open(id)
	if err != nil {
		t.Fatalf("sessiondb.Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}

func TestGenerateCoaching(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		taskType  string
		phase     string
		changed   string
		domain    string
		wantEmpty bool
		wantSub   string // substring that should appear in output
	}{
		{
			name:      "no phase change",
			taskType:  "bugfix",
			phase:     "read",
			changed:   "",
			wantEmpty: true,
		},
		{
			name:     "bugfix explore",
			taskType: "bugfix",
			phase:    "read",
			changed:  "true",
			wantSub:  "Reproduce the bug",
		},
		{
			name:     "bugfix implement",
			taskType: "bugfix",
			phase:    "write",
			changed:  "true",
			wantSub:  "root cause",
		},
		{
			name:     "feature implement",
			taskType: "feature",
			phase:    "write",
			changed:  "true",
			wantSub:  "tests alongside",
		},
		{
			name:     "refactor verify",
			taskType: "refactor",
			phase:    "compile",
			changed:  "true",
			wantSub:  "full test suite",
		},
		{
			name:      "unknown task type",
			taskType:  "",
			phase:     "write",
			changed:   "true",
			wantEmpty: true,
		},
		{
			name:     "domain override auth feature",
			taskType: "feature",
			phase:    "write",
			changed:  "true",
			domain:   "auth",
			wantSub:  "negative tests first",
		},
		{
			name:     "domain override database refactor",
			taskType: "refactor",
			phase:    "write",
			changed:  "true",
			domain:   "database",
			wantSub:  "existing migration files",
		},
		{
			name:     "explore explore phase",
			taskType: "explore",
			phase:    "read",
			changed:  "true",
			wantSub:  "entry points",
		},
		{
			name:     "debug reproduce phase",
			taskType: "debug",
			phase:    "read",
			changed:  "true",
			wantSub:  "runtime evidence",
		},
		{
			name:     "review explore phase",
			taskType: "review",
			phase:    "read",
			changed:  "true",
			wantSub:  "PR description",
		},
		{
			name:     "docs implement phase",
			taskType: "docs",
			phase:    "write",
			changed:  "true",
			wantSub:  "what",
		},
		{
			name:     "domain override api feature",
			taskType: "feature",
			phase:    "write",
			changed:  "true",
			domain:   "api",
			wantSub:  "request/response schema",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			sdb := openCoachingTestDB(t)
			_ = sdb.SetContext("task_type", tt.taskType)
			_ = sdb.SetContext("prev_phase", tt.phase)
			_ = sdb.SetContext("coaching_phase_changed", tt.changed)
			if tt.domain != "" {
				_ = sdb.SetWorkingSet("domain", tt.domain)
			}

			got := generateCoaching(sdb)
			if tt.wantEmpty && got != "" {
				t.Errorf("generateCoaching() = %q, want empty", got)
			}
			if !tt.wantEmpty && got == "" {
				t.Errorf("generateCoaching() = empty, want substring %q", tt.wantSub)
			}
			if tt.wantSub != "" && !strings.Contains(got, tt.wantSub) {
				t.Errorf("generateCoaching() = %q, want substring %q", got, tt.wantSub)
			}
		})
	}
}

func TestGenerateCoachingCooldown(t *testing.T) {
	t.Parallel()
	sdb := openCoachingTestDB(t)
	_ = sdb.SetContext("task_type", "bugfix")
	_ = sdb.SetContext("prev_phase", "read")
	_ = sdb.SetContext("coaching_phase_changed", "true")

	// First call should produce coaching.
	got := generateCoaching(sdb)
	if got == "" {
		t.Fatal("first generateCoaching() = empty, want coaching")
	}

	// Second call should be suppressed by cooldown.
	_ = sdb.SetContext("coaching_phase_changed", "true")
	got = generateCoaching(sdb)
	if got != "" {
		t.Errorf("second generateCoaching() = %q, want empty (cooldown)", got)
	}
}

func TestPreActionCoaching(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		toolName  string
		input     map[string]any
		taskType  string
		build     string
		domain    string
		wantEmpty bool
		wantSub   string
	}{
		{
			name:      "first edit without test read",
			toolName:  "Edit",
			input:     map[string]any{"file_path": "/foo/bar.go"},
			taskType:  "bugfix",
			wantEmpty: false,
			wantSub:   "reading test files",
		},
		{
			name:      "test with broken build",
			toolName:  "Bash",
			input:     map[string]any{"command": "go test ./..."},
			taskType:  "feature",
			build:     "false",
			wantEmpty: false,
			wantSub:   "broken build",
		},
		{
			name:      "domain auth core flow",
			toolName:  "Edit",
			input:     map[string]any{"file_path": "/app/auth_handler.go"},
			taskType:  "", // empty task type so trigger 1 doesn't fire
			domain:    "auth",
			wantEmpty: false,
			wantSub:   "core auth flow",
		},
		{
			name:      "domain database schema edit",
			toolName:  "Edit",
			input:     map[string]any{"file_path": "/app/migration_001.go"},
			taskType:  "",
			domain:    "database",
			wantEmpty: false,
			wantSub:   "database schema",
		},
		{
			name:      "domain infra deploy",
			toolName:  "Bash",
			input:     map[string]any{"command": "terraform apply"},
			taskType:  "",
			domain:    "infra",
			wantEmpty: false,
			wantSub:   "deployment command",
		},
		{
			name:      "normal edit no coaching",
			toolName:  "Edit",
			input:     map[string]any{"file_path": "/foo/bar.go"},
			taskType:  "",
			wantEmpty: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			sdb := openCoachingTestDB(t)
			if tt.taskType != "" {
				_ = sdb.SetContext("task_type", tt.taskType)
			}
			if tt.build != "" {
				_ = sdb.SetContext("last_build_passed", tt.build)
			}
			if tt.domain != "" {
				_ = sdb.SetWorkingSet("domain", tt.domain)
			}

			got := preActionCoaching(sdb, tt.toolName, tt.input)
			if tt.wantEmpty && got != "" {
				t.Errorf("preActionCoaching() = %q, want empty", got)
			}
			if !tt.wantEmpty && got == "" {
				t.Errorf("preActionCoaching() = empty, want substring %q", tt.wantSub)
			}
			if tt.wantSub != "" && !strings.Contains(got, tt.wantSub) {
				t.Errorf("preActionCoaching() = %q, want substring %q", got, tt.wantSub)
			}
		})
	}
}

func TestMapRawPhaseStr(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input string
		want  Phase
	}{
		{"read", PhaseExplore},
		{"write", PhaseImplement},
		{"test", PhaseTest},
		{"compile", PhaseVerify},
		{"plan", PhasePlan},
		{"", PhaseUnknown},
		{"unknown", PhaseUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			if got := mapRawPhaseStr(tt.input); got != tt.want {
				t.Errorf("mapRawPhaseStr(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
