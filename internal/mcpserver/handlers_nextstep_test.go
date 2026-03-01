package mcpserver

import (
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

func openNextStepTestDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	id := "test-nextstep-" + strings.ReplaceAll(t.Name(), "/", "-")
	sdb, err := sessiondb.Open(id)
	if err != nil {
		t.Fatalf("sessiondb.Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}

func TestBuildNextSteps_UnresolvedFailure(t *testing.T) {
	t.Parallel()
	sdb := openNextStepTestDB(t)

	_ = sdb.RecordFailure("Bash", "test_failure", "FAIL TestFoo", "/src/foo.go")

	steps := buildNextSteps(sdb, "")
	if len(steps) == 0 {
		t.Fatal("buildNextSteps() returned 0 steps, want at least 1")
	}
	if steps[0].Priority != "high" {
		t.Errorf("first step priority = %q, want \"high\"", steps[0].Priority)
	}
	if !strings.Contains(steps[0].Action, "foo.go") {
		t.Errorf("first step action = %q, want to mention foo.go", steps[0].Action)
	}
}

func TestBuildNextSteps_BuildFailed(t *testing.T) {
	t.Parallel()
	sdb := openNextStepTestDB(t)

	_ = sdb.SetContext("last_build_passed", "false")

	steps := buildNextSteps(sdb, "")
	found := false
	for _, s := range steps {
		if strings.Contains(s.Action, "compilation") {
			found = true
			if s.Priority != "high" {
				t.Errorf("build failure step priority = %q, want \"high\"", s.Priority)
			}
		}
	}
	if !found {
		t.Error("buildNextSteps() did not include build failure step")
	}
}

func TestBuildNextSteps_TestsNeeded(t *testing.T) {
	t.Parallel()
	sdb := openNextStepTestDB(t)

	_ = sdb.AddWorkingSetFile("/src/main.go")
	_ = sdb.SetWorkingSet("task_type", "feature")

	steps := buildNextSteps(sdb, "")
	found := false
	for _, s := range steps {
		if strings.Contains(s.Action, "Run tests") {
			found = true
		}
	}
	if !found {
		t.Error("buildNextSteps() did not suggest running tests")
	}
}

func TestBuildNextSteps_TestsFailed(t *testing.T) {
	t.Parallel()
	sdb := openNextStepTestDB(t)

	_ = sdb.SetContext("has_test_run", "true")
	_ = sdb.SetContext("last_test_passed", "false")

	steps := buildNextSteps(sdb, "")
	found := false
	for _, s := range steps {
		if strings.Contains(s.Action, "failing tests") {
			found = true
			if s.Priority != "high" {
				t.Errorf("test failure step priority = %q, want \"high\"", s.Priority)
			}
		}
	}
	if !found {
		t.Error("buildNextSteps() did not suggest fixing failing tests")
	}
}

func TestBuildNextSteps_DefaultPlaybook(t *testing.T) {
	t.Parallel()
	sdb := openNextStepTestDB(t)

	// Clean session with no failures → should get default playbook.
	steps := buildNextSteps(sdb, "")
	if len(steps) == 0 {
		t.Fatal("buildNextSteps() returned 0 steps on clean session")
	}
	if steps[len(steps)-1].Priority != "low" {
		t.Errorf("default step priority = %q, want \"low\"", steps[len(steps)-1].Priority)
	}
}

func TestBuildNextSteps_MaxThree(t *testing.T) {
	t.Parallel()
	sdb := openNextStepTestDB(t)

	// Trigger multiple high-priority rules simultaneously.
	_ = sdb.RecordFailure("Bash", "test_failure", "FAIL", "/src/a.go")
	_ = sdb.SetContext("last_build_passed", "false")
	_ = sdb.SetContext("has_test_run", "true")
	_ = sdb.SetContext("last_test_passed", "false")
	_ = sdb.AddWorkingSetFile("/src/b.go")
	_ = sdb.SetWorkingSet("task_type", "bugfix")

	steps := buildNextSteps(sdb, "")
	if len(steps) > 3 {
		t.Errorf("buildNextSteps() returned %d steps, want at most 3", len(steps))
	}
}

func TestBuildNextSteps_UserContext(t *testing.T) {
	t.Parallel()
	sdb := openNextStepTestDB(t)

	steps := buildNextSteps(sdb, "Implement caching layer")
	found := false
	for _, s := range steps {
		if s.Action == "Implement caching layer" {
			found = true
		}
	}
	if !found {
		t.Error("buildNextSteps() did not include user context step")
	}
}
