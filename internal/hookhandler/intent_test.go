package hookhandler

import (
	"testing"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

func openIntentTestDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	sdb, err := sessiondb.Open("test-intent-" + t.Name())
	if err != nil {
		t.Fatalf("sessiondb.Open: %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}

func TestClassifyComplexity(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		prompt   string
		taskType TaskType
		want     TaskComplexity
	}{
		{"mechanical delete", "delete all DynamoDB tables", TaskUnknown, ComplexityLow},
		{"mechanical remove", "remove the old migration files", TaskRefactor, ComplexityLow},
		{"mechanical rename", "rename config to settings", TaskUnknown, ComplexityLow},
		{"mechanical japanese", "DynamoDB関連を全部消す", TaskUnknown, ComplexityLow},
		{"mechanical format", "format all go files", TaskUnknown, ComplexityLow},
		{"short unknown", "do it", TaskUnknown, ComplexityLow},
		{"explore", "how does the auth module work", TaskExplore, ComplexityLow},
		{"docs", "update the readme", TaskDocs, ComplexityLow},
		{"review", "review the PR", TaskReview, ComplexityLow},
		{"bugfix", "fix the race condition in middleware", TaskBugfix, ComplexityMedium},
		{"test", "add tests for the parser", TaskTest, ComplexityMedium},
		{"debug", "debug the memory leak", TaskDebug, ComplexityMedium},
		{"feature", "implement Redis caching layer", TaskFeature, ComplexityHigh},
		{"refactor", "refactor payment module to strategy pattern", TaskRefactor, ComplexityHigh},
		{"default unknown", "something interesting happening here today", TaskUnknown, ComplexityMedium},
		{"empty prompt", "", TaskUnknown, ComplexityLow},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := classifyComplexity(tt.prompt, tt.taskType)
			if got != tt.want {
				t.Errorf("classifyComplexity(%q, %q) = %q, want %q",
					tt.prompt, tt.taskType, got, tt.want)
			}
		})
	}
}

func TestCurrentTaskComplexity(t *testing.T) {
	t.Parallel()
	sdb := openIntentTestDB(t)

	if got := currentTaskComplexity(sdb); got != ComplexityUnknown {
		t.Errorf("fresh db: currentTaskComplexity() = %q, want %q", got, ComplexityUnknown)
	}

	_ = sdb.SetContext("task_complexity", "low")
	if got := currentTaskComplexity(sdb); got != ComplexityLow {
		t.Errorf("after set low: currentTaskComplexity() = %q, want %q", got, ComplexityLow)
	}

	_ = sdb.SetContext("task_complexity", "invalid")
	if got := currentTaskComplexity(sdb); got != ComplexityUnknown {
		t.Errorf("invalid value: currentTaskComplexity() = %q, want %q", got, ComplexityUnknown)
	}
}

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

