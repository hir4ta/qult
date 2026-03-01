package hookhandler

import (
	"regexp"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

// TaskType represents the classified intent of the user's prompt.
type TaskType string

const (
	TaskBugfix   TaskType = "bugfix"
	TaskFeature  TaskType = "feature"
	TaskRefactor TaskType = "refactor"
	TaskTest     TaskType = "test"
	TaskExplore  TaskType = "explore"
	TaskDebug    TaskType = "debug"
	TaskReview   TaskType = "review"
	TaskDocs     TaskType = "docs"
	TaskUnknown  TaskType = ""
)

// classifyIntent classifies user intent using keyword matching.
// Returns TaskUnknown if no clear classification.
func classifyIntent(intent string) TaskType {
	lower := strings.ToLower(intent)

	// Order matters: test before feature (since "add test" should be test, not feature).
	for _, kw := range []string{
		"test", "coverage", "spec", "unittest", "e2e", "acceptance",
		"assert", "mock", "stub", "snapshot", "benchmark",
	} {
		if strings.Contains(lower, kw) {
			return TaskTest
		}
	}
	for _, kw := range []string{
		"fix", "bug", "error", "broken", "crash", "regression", "revert",
		"rollback", "hotfix", "patch", "workaround", "panic", "nil pointer",
	} {
		if strings.Contains(lower, kw) {
			return TaskBugfix
		}
	}
	for _, kw := range []string{
		"refactor", "clean", "reorganize", "simplify", "deprecate",
		"migrate", "upgrade", "modernize", "optimize", "decouple", "extract", "inline",
	} {
		if strings.Contains(lower, kw) {
			return TaskRefactor
		}
	}
	for _, kw := range []string{
		"add", "implement", "create", "build", "new", "endpoint",
		"integration", "api", "plugin", "extension", "handler", "middleware", "route",
	} {
		if strings.Contains(lower, kw) {
			return TaskFeature
		}
	}
	for _, kw := range []string{
		"explore", "investigate", "understand", "how does", "what is", "where is",
		"how to", "poc", "analyze", "research", "spike", "prototype",
	} {
		if strings.Contains(lower, kw) {
			return TaskExplore
		}
	}
	for _, kw := range []string{
		"debug", "trace", "breakpoint", "inspect", "step through",
		"print debug", "verbose", "logging", "stack trace", "profile",
	} {
		if strings.Contains(lower, kw) {
			return TaskDebug
		}
	}
	for _, kw := range []string{
		"review", "check", "audit", "approve", "feedback",
		"pull request", "pr", "diff", "merge request",
	} {
		if strings.Contains(lower, kw) {
			return TaskReview
		}
	}
	for _, kw := range []string{
		"document", "readme", "comment", "jsdoc", "godoc",
		"changelog", "api doc", "swagger", "openapi", "docstring",
	} {
		if strings.Contains(lower, kw) {
			return TaskDocs
		}
	}

	return TaskUnknown
}

// TaskComplexity estimates the cognitive and implementation complexity of a task.
// Used to gate suggestion delivery — low-complexity tasks need fewer suggestions.
type TaskComplexity string

const (
	ComplexityLow     TaskComplexity = "low"
	ComplexityMedium  TaskComplexity = "medium"
	ComplexityHigh    TaskComplexity = "high"
	ComplexityUnknown TaskComplexity = ""
)

// mechanicalKeywords indicate simple, repetitive, or one-step operations
// that override task-type-based complexity classification.
var mechanicalKeywords = []string{
	"delete", "remove", "drop", "rename", "replace all",
	"format", "lint", "sort", "enable", "disable",
	"全部消す", "全部削除", "一括", "リネーム",
}

// classifyComplexity estimates task complexity from the prompt and task type.
// Mechanical keywords override task type (e.g., "delete all X" → Low even for refactor).
func classifyComplexity(prompt string, taskType TaskType) TaskComplexity {
	lower := strings.ToLower(prompt)

	// Mechanical keywords → Low regardless of task type.
	for _, kw := range mechanicalKeywords {
		if strings.Contains(lower, kw) {
			return ComplexityLow
		}
	}

	// Short prompts with unknown task type are typically simple instructions.
	if len([]rune(prompt)) < 20 && taskType == TaskUnknown {
		return ComplexityLow
	}

	switch taskType {
	case TaskExplore, TaskDocs, TaskReview:
		return ComplexityLow
	case TaskBugfix, TaskTest, TaskDebug:
		return ComplexityMedium
	case TaskFeature, TaskRefactor:
		return ComplexityHigh
	default:
		return ComplexityMedium
	}
}

// currentTaskComplexity reads the cached task_complexity from sessiondb.
func currentTaskComplexity(sdb *sessiondb.SessionDB) TaskComplexity {
	val, _ := sdb.GetContext("task_complexity")
	switch TaskComplexity(val) {
	case ComplexityLow, ComplexityMedium, ComplexityHigh:
		return TaskComplexity(val)
	default:
		return ComplexityUnknown
	}
}

// testCmdPattern matches common test runner commands.
var testCmdPattern = regexp.MustCompile(`\b(go\s+test|npm\s+test|npx\s+(jest|vitest)|pytest|cargo\s+test|make\s+test|bundle\s+exec\s+rspec)\b`)

// decisionKeywords detects when a user prompt contains a design decision.
var decisionKeywords = []string{
	"decided to", "going with", "opted for", "will use", "instead of",
	"let's go with", "let's use", "choosing", "approach:",
	"trade-off", "tradeoff", "prefer", "selected", "picked",
	"switching to", "moving to", "better to", "went with",
	"the plan is", "strategy:",
}

// containsDecisionKeyword returns true if the text contains a decision indicator.
func containsDecisionKeyword(text string) bool {
	lower := strings.ToLower(text)
	for _, kw := range decisionKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

