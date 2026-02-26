package hookhandler

import (
	"strings"
	"testing"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

func openTestSessionDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	id := "test-stop-" + strings.ReplaceAll(t.Name(), "/", "-")
	sdb, err := sessiondb.Open(id)
	if err != nil {
		t.Fatalf("sessiondb.Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}

func TestCheckBuildStatus(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		buildCtx     string
		wantBlocking bool
	}{
		{"no build context", "", false},
		{"build passed", "true", false},
		{"build failed", "false", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			sdb := openTestSessionDB(t)
			if tt.buildCtx != "" {
				_ = sdb.SetContext("last_build_passed", tt.buildCtx)
			}
			result := checkBuildStatus(sdb)
			if tt.wantBlocking && result == "" {
				t.Error("checkBuildStatus() = \"\", want blocking message")
			}
			if !tt.wantBlocking && result != "" {
				t.Errorf("checkBuildStatus() = %q, want \"\"", result)
			}
		})
	}
}

func TestCheckTestResults(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		hasTestRun   string
		testPassed   string
		wantBlocking bool
	}{
		{"no tests run", "", "", false},
		{"tests run and passed", "true", "true", false},
		{"tests run and failed", "true", "false", true},
		{"tests run no result yet", "true", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			sdb := openTestSessionDB(t)
			if tt.hasTestRun != "" {
				_ = sdb.SetContext("has_test_run", tt.hasTestRun)
			}
			if tt.testPassed != "" {
				_ = sdb.SetContext("last_test_passed", tt.testPassed)
			}
			result := checkTestResults(sdb)
			if tt.wantBlocking && result == "" {
				t.Error("checkTestResults() = \"\", want blocking message")
			}
			if !tt.wantBlocking && result != "" {
				t.Errorf("checkTestResults() = %q, want \"\"", result)
			}
		})
	}
}
