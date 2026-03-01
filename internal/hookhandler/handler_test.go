package hookhandler

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

func TestMakeOutput(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		event    string
		context  string
		wantNil  bool
	}{
		{name: "empty context returns nil", event: "Test", context: "", wantNil: true},
		{name: "non-empty context returns output", event: "Test", context: "hello", wantNil: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			out := makeOutput(tt.event, tt.context)
			if tt.wantNil && out != nil {
				t.Errorf("makeOutput(%q, %q) = non-nil, want nil", tt.event, tt.context)
			}
			if !tt.wantNil && out == nil {
				t.Errorf("makeOutput(%q, %q) = nil, want non-nil", tt.event, tt.context)
			}
			if !tt.wantNil {
				ac := out.HookSpecificOutput["additionalContext"]
				if ac != "hello" {
					t.Errorf("additionalContext = %v, want hello", ac)
				}
			}
		})
	}
}

func TestMakeDenyOutput(t *testing.T) {
	t.Parallel()

	out := makeDenyOutput("destructive command")
	if out == nil {
		t.Fatal("makeDenyOutput() = nil, want non-nil")
	}
	if out.HookSpecificOutput["permissionDecision"] != "deny" {
		t.Errorf("permissionDecision = %v, want deny", out.HookSpecificOutput["permissionDecision"])
	}
	if out.HookSpecificOutput["permissionDecisionReason"] != "destructive command" {
		t.Errorf("permissionDecisionReason = %v, want 'destructive command'", out.HookSpecificOutput["permissionDecisionReason"])
	}
}

func TestFormatNudges(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		nudges  []nudgeEntry
		wantLen int
	}{
		{name: "empty", nudges: nil, wantLen: 0},
		{name: "single", nudges: []nudgeEntry{{Pattern: "test", Level: "warn", Observation: "obs", Suggestion: "sug"}}, wantLen: 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			result := formatNudges(tt.nudges)
			if tt.wantLen == 0 && result != "" {
				t.Errorf("formatNudges() = %q, want empty", result)
			}
			if tt.wantLen > 0 && result == "" {
				t.Error("formatNudges() = empty, want non-empty")
			}
		})
	}
}

func TestHandlePreToolUse_DestructiveCommand(t *testing.T) {
	t.Parallel()

	input := preToolUseInput{
		CommonInput: CommonInput{
			SessionID:     "test-pre-tool-use",
			HookEventName: "PreToolUse",
		},
		ToolName:  "Bash",
		ToolInput: json.RawMessage(`{"command":"rm -rf /"}`),
	}
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("json.Marshal() = %v", err)
	}

	out, err := handlePreToolUse(data)
	if err != nil {
		t.Fatalf("handlePreToolUse() = %v", err)
	}
	if out == nil {
		t.Fatal("handlePreToolUse() = nil, want deny output for destructive command")
	}
	if out.HookSpecificOutput["permissionDecision"] != "deny" {
		t.Errorf("permissionDecision = %v, want deny", out.HookSpecificOutput["permissionDecision"])
	}
}

func TestHandlePreToolUse_SafeCommand(t *testing.T) {
	t.Parallel()

	input := preToolUseInput{
		CommonInput: CommonInput{
			SessionID:     "test-pre-tool-safe",
			HookEventName: "PreToolUse",
		},
		ToolName:  "Bash",
		ToolInput: json.RawMessage(`{"command":"ls -la"}`),
	}
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("json.Marshal() = %v", err)
	}
	t.Cleanup(func() {
		sdb, _ := sessiondb.Open("test-pre-tool-safe")
		if sdb != nil {
			_ = sdb.Destroy()
		}
	})

	out, err := handlePreToolUse(data)
	if err != nil {
		t.Fatalf("handlePreToolUse() = %v", err)
	}
	// Safe command with no pending nudges → no deny/ask output.
	// Advisory additionalContext output is acceptable (depends on buddy.db state).
	if out != nil {
		if decision, ok := out.HookSpecificOutput["permissionDecision"]; ok {
			t.Errorf("handlePreToolUse(safe) has permissionDecision=%v, want no blocking decision", decision)
		}
	}
}

func TestHandlePostToolUse_RecordsEvent(t *testing.T) {
	t.Parallel()

	sessionID := "test-post-tool"
	t.Cleanup(func() {
		sdb, _ := sessiondb.Open(sessionID)
		if sdb != nil {
			_ = sdb.Destroy()
		}
	})

	input := postToolUseInput{
		CommonInput: CommonInput{SessionID: sessionID},
		ToolName:    "Read",
		ToolInput:   json.RawMessage(`{"file_path":"/src/main.go"}`),
	}
	data, _ := json.Marshal(input)

	_, err := handlePostToolUse(data)
	if err != nil {
		t.Fatalf("handlePostToolUse() = %v", err)
	}
	// Note: out may be non-nil if advisor signals fire (e.g., file context knowledge).
	// The important assertion is that the event was recorded correctly.

	// Verify event was recorded.
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	defer sdb.Close()

	events, _ := sdb.RecentEvents(5)
	if len(events) != 1 {
		t.Fatalf("RecentEvents() = %d, want 1", len(events))
	}
	if events[0].ToolName != "Read" {
		t.Errorf("event.ToolName = %q, want Read", events[0].ToolName)
	}
}

func TestHandleUserPromptSubmit_ResetsBurst(t *testing.T) {
	t.Parallel()

	sessionID := "test-user-prompt"
	t.Cleanup(func() {
		sdb, _ := sessiondb.Open(sessionID)
		if sdb != nil {
			_ = sdb.Destroy()
		}
	})

	// Setup: record some events first.
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	_ = sdb.RecordEvent("Read", 1, false)
	_ = sdb.RecordEvent("Read", 2, false)
	sdb.Close()

	input := userPromptInput{
		CommonInput: CommonInput{SessionID: sessionID},
		Prompt:      "test prompt",
	}
	data, _ := json.Marshal(input)

	_, err = handleUserPromptSubmit(data)
	if err != nil {
		t.Fatalf("handleUserPromptSubmit() = %v", err)
	}

	// Verify burst was reset.
	sdb, _ = sessiondb.Open(sessionID)
	defer sdb.Close()
	tc, _, _, _ := sdb.BurstState()
	if tc != 0 {
		t.Errorf("tool_count after user prompt = %d, want 0", tc)
	}
}

func TestHandlePreCompact_RecordsCompact(t *testing.T) {
	t.Parallel()

	sessionID := "test-pre-compact"
	t.Cleanup(func() {
		sdb, _ := sessiondb.Open(sessionID)
		if sdb != nil {
			_ = sdb.Destroy()
		}
	})

	input := preCompactInput{
		CommonInput: CommonInput{SessionID: sessionID},
		Trigger:     "auto",
	}
	data, _ := json.Marshal(input)

	out, err := handlePreCompact(data)
	if err != nil {
		t.Fatalf("handlePreCompact() = %v", err)
	}
	if out != nil {
		t.Error("handlePreCompact() should return nil (no additionalContext support)")
	}

	// Verify compact was recorded.
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	defer sdb.Close()

	count, _ := sdb.CompactsInWindow(15)
	if count != 1 {
		t.Errorf("CompactsInWindow(15) = %d, want 1", count)
	}
}

func TestHandleSessionEnd_DestroysDB(t *testing.T) {
	t.Parallel()

	sessionID := "test-session-end"

	// Pre-create session DB.
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	sdb.Close()

	input := sessionEndInput{
		CommonInput: CommonInput{SessionID: sessionID},
		Reason:      "user_exit",
	}
	data, _ := json.Marshal(input)

	out, err := handleSessionEnd(data)
	if err != nil {
		t.Fatalf("handleSessionEnd() = %v", err)
	}
	if out != nil {
		t.Error("handleSessionEnd() should return nil")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchSubstring(s, substr)
}

func searchSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestSuggestedToolForPattern_DefaultEmpty(t *testing.T) {
	t.Parallel()
	tests := []struct {
		pattern string
		want    string
	}{
		{"retry-loop", "buddy_diagnose"},
		{"explore-stuck", "buddy_diagnose"},
		{"knowledge", "buddy_knowledge"},
		{"health-decline", "buddy_state"},
		{"co-change", "buddy_analyze"},
		{"session-context", ""},
		{"task-briefing", ""},
		{"briefing", ""},
		{"predictive-context", ""},
		{"unknown-pattern", ""},
	}
	for _, tt := range tests {
		t.Run(tt.pattern, func(t *testing.T) {
			t.Parallel()
			got := suggestedToolForPattern(tt.pattern)
			if got != tt.want {
				t.Errorf("suggestedToolForPattern(%q) = %q, want %q", tt.pattern, got, tt.want)
			}
		})
	}
}

func TestEnrichOutput_FirstActionableEntry(t *testing.T) {
	t.Parallel()

	// When entries start with informational patterns, the first actionable one wins.
	entries := []nudgeEntry{
		{Pattern: "session-context", Level: "info", Observation: "ctx", Suggestion: "..."},
		{Pattern: "task-briefing", Level: "info", Observation: "brief", Suggestion: "..."},
		{Pattern: "retry-loop", Level: "action", Observation: "loop", Suggestion: "..."},
	}
	out := makeOutput("UserPromptSubmit", formatNudges(entries))
	for _, e := range entries {
		if tool := suggestedToolForPattern(e.Pattern); tool != "" {
			enrichOutput(out, tool)
			break
		}
	}
	ctx, _ := out.HookSpecificOutput["additionalContext"].(string)
	if !contains(ctx, "[suggested: buddy_diagnose]") {
		t.Errorf("expected buddy_diagnose from retry-loop, got: %q", ctx)
	}

	// When no entry has a matching tool, no suggestion is appended.
	infoOnly := []nudgeEntry{
		{Pattern: "session-context", Level: "info", Observation: "ctx", Suggestion: "..."},
		{Pattern: "task-briefing", Level: "info", Observation: "brief", Suggestion: "..."},
	}
	out2 := makeOutput("UserPromptSubmit", formatNudges(infoOnly))
	for _, e := range infoOnly {
		if tool := suggestedToolForPattern(e.Pattern); tool != "" {
			enrichOutput(out2, tool)
			break
		}
	}
	ctx2, _ := out2.HookSpecificOutput["additionalContext"].(string)
	if contains(ctx2, "[suggested:") {
		t.Errorf("expected no suggestion for info-only entries, got: %q", ctx2)
	}
}

func TestEnrichOutput(t *testing.T) {
	t.Parallel()

	// nil output is safe.
	enrichOutput(nil, "buddy_diagnose")

	// Empty tool is a no-op.
	out := makeOutput("PostToolUse", "some context")
	enrichOutput(out, "")
	ctx, _ := out.HookSpecificOutput["additionalContext"].(string)
	if ctx != "some context" {
		t.Errorf("enrichOutput('') modified context: got %q", ctx)
	}

	// Non-empty tool appends suggestion.
	enrichOutput(out, "buddy_diagnose")
	ctx, _ = out.HookSpecificOutput["additionalContext"].(string)
	want := "some context\n[suggested: buddy_diagnose]"
	if ctx != want {
		t.Errorf("enrichOutput() = %q, want %q", ctx, want)
	}
}

func TestHashInput(t *testing.T) {
	t.Parallel()

	h1 := hashInput("Bash", json.RawMessage(`{"command":"ls"}`))
	h2 := hashInput("Bash", json.RawMessage(`{"command":"ls"}`))
	h3 := hashInput("Bash", json.RawMessage(`{"command":"pwd"}`))

	if h1 != h2 {
		t.Error("hashInput() not deterministic for same input")
	}
	if h1 == h3 {
		t.Error("hashInput() collision for different input")
	}
}

func TestSerializeWorkingSetForCompact(t *testing.T) {
	t.Parallel()

	sessionID := "test-ws-serialize"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Populate working set.
	_ = sdb.SetWorkingSet("intent", "fix authentication bug")
	_ = sdb.SetWorkingSet("task_type", "bugfix")
	_ = sdb.AddWorkingSetFile("/src/auth.go")
	_ = sdb.AddWorkingSetFile("/src/middleware.go")
	_ = sdb.AddWorkingSetDecision("Use JWT with refresh tokens")

	serializeWorkingSetForCompact(sdb)

	// Verify nudge was enqueued.
	nudges, _ := sdb.DequeueNudges(5)
	if len(nudges) == 0 {
		t.Fatal("serializeWorkingSetForCompact() enqueued no nudges")
	}

	found := false
	for _, n := range nudges {
		if n.Pattern == "compact_context" {
			found = true
			if !strings.Contains(n.Suggestion, "fix authentication bug") {
				t.Errorf("nudge missing intent, got: %s", n.Suggestion)
			}
			if !strings.Contains(n.Suggestion, "/src/auth.go") {
				t.Errorf("nudge missing file, got: %s", n.Suggestion)
			}
			if !strings.Contains(n.Suggestion, "JWT with refresh tokens") {
				t.Errorf("nudge missing decision, got: %s", n.Suggestion)
			}
		}
	}
	if !found {
		t.Error("no compact_context nudge found")
	}
}

func TestSerializeWorkingSetForCompact_Empty(t *testing.T) {
	t.Parallel()

	sessionID := "test-ws-serialize-empty"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	serializeWorkingSetForCompact(sdb)

	nudges, _ := sdb.DequeueNudges(5)
	if len(nudges) != 0 {
		t.Errorf("empty working set should enqueue no nudges, got %d", len(nudges))
	}
}

func TestContainsDecisionKeyword(t *testing.T) {
	t.Parallel()

	tests := []struct {
		text string
		want bool
	}{
		{"Let's go with JWT for auth", true},
		{"I decided to use PostgreSQL", true},
		{"Going with the simpler approach", true},
		{"I opted for JWT tokens", true},
		{"Fix the bug in auth.go", false},
		{"Read the file first", false},
	}
	for _, tt := range tests {
		t.Run(tt.text, func(t *testing.T) {
			t.Parallel()
			got := containsDecisionKeyword(tt.text)
			if got != tt.want {
				t.Errorf("containsDecisionKeyword(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestPostCompactResume_WithWorkingSet(t *testing.T) {
	t.Parallel()

	sessionID := "test-compact-resume-ws"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Simulate pre-compact serialization.
	_ = sdb.SetWorkingSet("intent", "refactor middleware")
	_ = sdb.AddWorkingSetFile("/src/middleware.go")
	serializeWorkingSetForCompact(sdb)

	// Simulate post-compact resume.
	out, err := handlePostCompactResume(sdb)
	if err != nil {
		t.Fatalf("handlePostCompactResume() = %v", err)
	}
	if out == nil {
		t.Fatal("handlePostCompactResume() = nil, want output with context")
	}

	ctx, _ := out.HookSpecificOutput["additionalContext"].(string)
	if !strings.Contains(ctx, "refactor middleware") {
		t.Errorf("context missing intent, got: %s", ctx)
	}
	if !strings.Contains(ctx, "/src/middleware.go") {
		t.Errorf("context missing file, got: %s", ctx)
	}
}


func TestCaptureGitContext(t *testing.T) {
	t.Parallel()

	sessionID := "test-capture-git"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Use the current repo (claude-buddy) as the test target.
	captureGitContext(sdb, "/Users/user/Projects/claude-buddy")

	branch, _ := sdb.GetWorkingSet("git_branch")
	if branch == "" {
		t.Error("captureGitContext() did not set git_branch")
	}
}

func TestCaptureGitContext_NotGitRepo(t *testing.T) {
	t.Parallel()

	sessionID := "test-capture-git-norepo"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// /tmp is not a git repo.
	captureGitContext(sdb, "/tmp")

	branch, _ := sdb.GetWorkingSet("git_branch")
	if branch != "" {
		t.Errorf("captureGitContext(/tmp) set git_branch = %q, want empty", branch)
	}
}

func TestFormatResumeContext_Nil(t *testing.T) {
	t.Parallel()

	if result := FormatResumeContext(nil); result != "" {
		t.Errorf("FormatResumeContext(nil) = %q, want empty", result)
	}
	if result := FormatResumeContext(&ResumeData{}); result != "" {
		t.Errorf("FormatResumeContext(empty) = %q, want empty", result)
	}
}

