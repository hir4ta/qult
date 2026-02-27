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
	// Safe command with no pending nudges → nil output.
	if out != nil {
		t.Errorf("handlePreToolUse(safe) = non-nil, want nil")
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

func TestDetector_RetryLoop_Signal(t *testing.T) {
	t.Parallel()

	sessionID := "test-detector-retry-signal"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Record 3 identical events (new threshold).
	for range 3 {
		_ = sdb.RecordEvent("Bash", 12345, false)
	}

	det := &HookDetector{sdb: sdb}
	sig := det.detectRetryLoop()

	if sig == "" {
		t.Fatal("detectRetryLoop() returned empty signal for 3 identical calls")
	}
	if !contains(sig, "[buddy] Signal:") {
		t.Errorf("signal = %q, want [buddy] Signal: prefix", sig)
	}
	if !contains(sig, "Bash") {
		t.Errorf("signal = %q, want to contain tool name Bash", sig)
	}
}

func TestDetector_RetryLoop_BelowThreshold(t *testing.T) {
	t.Parallel()

	sessionID := "test-detector-retry-below"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Record only 2 identical events (below new threshold of 3).
	for range 2 {
		_ = sdb.RecordEvent("Bash", 12345, false)
	}

	det := &HookDetector{sdb: sdb}
	sig := det.detectRetryLoop()

	if sig != "" {
		t.Errorf("detectRetryLoop() = %q, want empty for 2 retries", sig)
	}
}

func TestDetector_RetryLoop_Cooldown(t *testing.T) {
	t.Parallel()

	sessionID := "test-detector-retry-cooldown-signal"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// First detection.
	for range 3 {
		_ = sdb.RecordEvent("Bash", 99999, false)
	}
	det := &HookDetector{sdb: sdb}
	sig1 := det.detectRetryLoop()
	if sig1 == "" {
		t.Fatal("first detectRetryLoop() should fire")
	}

	// Second detection — should be on cooldown.
	for range 3 {
		_ = sdb.RecordEvent("Bash", 99999, false)
	}
	sig2 := det.detectRetryLoop()
	if sig2 != "" {
		t.Errorf("detectRetryLoop() on cooldown = %q, want empty", sig2)
	}
}

func TestDetector_Detect_IntegrationSignal(t *testing.T) {
	t.Parallel()

	sessionID := "test-detector-detect-signal"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Record 3 identical events to trigger retry-loop.
	for range 3 {
		_ = sdb.RecordEvent("Edit", 55555, false)
	}

	det := &HookDetector{sdb: sdb}
	sig := det.Detect()

	if sig == "" {
		t.Fatal("Detect() should return a signal for 3 identical Edit calls")
	}
	if !contains(sig, "Edit") {
		t.Errorf("Detect() = %q, want to contain Edit", sig)
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

func TestHandleStop_StopHookActive(t *testing.T) {
	t.Parallel()

	input := stopInput{
		CommonInput:          CommonInput{SessionID: "test-stop-active"},
		StopHookActive:       true,
		LastAssistantMessage: "error: something failed",
	}
	data, _ := json.Marshal(input)

	out, err := handleStop(data)
	if err != nil {
		t.Fatalf("handleStop() = %v", err)
	}
	if out != nil {
		t.Error("handleStop() with stop_hook_active should return nil (allow stop)")
	}
}

func TestHandleStop_AllowsErrorExplanation(t *testing.T) {
	t.Parallel()

	// Error detection is left to the LLM prompt hook; command hook should not block.
	input := stopInput{
		CommonInput:          CommonInput{SessionID: "test-stop-error"},
		StopHookActive:       false,
		LastAssistantMessage: "I analyzed the issue and the root cause is a missing import in the module",
	}
	data, _ := json.Marshal(input)

	out, err := handleStop(data)
	if err != nil {
		t.Fatalf("handleStop() = %v", err)
	}
	if out != nil {
		t.Errorf("handleStop() should allow stop for error explanations, got Decision=%q", out.Decision)
	}
}

func TestHandleStop_DetectsTODO(t *testing.T) {
	t.Parallel()

	input := stopInput{
		CommonInput:          CommonInput{SessionID: "test-stop-todo"},
		StopHookActive:       false,
		LastAssistantMessage: "I've added a TODO: implement the validation logic later",
	}
	data, _ := json.Marshal(input)

	out, err := handleStop(data)
	if err != nil {
		t.Fatalf("handleStop() = %v", err)
	}
	if out == nil {
		t.Fatal("handleStop() should block when TODO detected")
	}
	if out.Decision != "block" {
		t.Errorf("Decision = %q, want block", out.Decision)
	}
}

func TestHandleStop_AllowsCleanStop(t *testing.T) {
	t.Parallel()

	input := stopInput{
		CommonInput:          CommonInput{SessionID: "test-stop-clean"},
		StopHookActive:       false,
		LastAssistantMessage: "All changes have been implemented and tests pass. The build succeeds.",
	}
	data, _ := json.Marshal(input)

	out, err := handleStop(data)
	if err != nil {
		t.Fatalf("handleStop() = %v", err)
	}
	if out != nil {
		t.Errorf("handleStop() should allow clean stop, got Decision=%q Reason=%q", out.Decision, out.Reason)
	}
}

func TestCheckCompleteness(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		msg       string
		wantIssue bool
	}{
		{name: "empty", msg: "", wantIssue: false},
		{name: "clean", msg: "All done, tests pass.", wantIssue: false},
		{name: "error explanation", msg: "I got an unexpected result from the API call", wantIssue: false},
		{name: "build failed", msg: "The build failed with 3 errors", wantIssue: true},
		{name: "todo marker", msg: "Added a TODO: fix this later", wantIssue: true},
		{name: "incomplete phrase", msg: "I'll finish the rest later, not yet implemented", wantIssue: true},
		{name: "placeholder", msg: "I left a placeholder for the auth logic", wantIssue: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			issues := checkCompleteness(tt.msg, true)
			if tt.wantIssue && len(issues) == 0 {
				t.Errorf("checkCompleteness(%q) = no issues, want at least 1", tt.msg)
			}
			if !tt.wantIssue && len(issues) > 0 {
				t.Errorf("checkCompleteness(%q) = %v, want no issues", tt.msg, issues)
			}
		})
	}
}

func TestMakeAsyncContextOutput(t *testing.T) {
	t.Parallel()

	if out := makeAsyncContextOutput(""); out != nil {
		t.Error("makeAsyncContextOutput('') should return nil")
	}

	out := makeAsyncContextOutput("test signal")
	if out == nil {
		t.Fatal("makeAsyncContextOutput('test signal') = nil")
	}
	if out.AdditionalContext != "test signal" {
		t.Errorf("AdditionalContext = %q, want 'test signal'", out.AdditionalContext)
	}
}

func TestMakeBlockStopOutput(t *testing.T) {
	t.Parallel()

	out := makeBlockStopOutput("work incomplete")
	if out == nil {
		t.Fatal("makeBlockStopOutput() = nil")
	}
	if out.Decision != "block" {
		t.Errorf("Decision = %q, want block", out.Decision)
	}
	if out.Reason != "work incomplete" {
		t.Errorf("Reason = %q, want 'work incomplete'", out.Reason)
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

func TestAlternativesGitDirtyWarning(t *testing.T) {
	t.Parallel()

	sessionID := "test-git-dirty-warn"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Set dirty files from git.
	_ = sdb.SetWorkingSet("git_dirty_files", "internal/auth/handler.go\ninternal/auth/middleware.go")
	_ = sdb.SetWorkingSet("git_branch", "feature/auth")

	// Editing a dirty file should include commit/stash alternative.
	input := json.RawMessage(`{"file_path":"/project/internal/auth/handler.go"}`)
	result := presentAlternatives(sdb, "Edit", input)
	if result == "" {
		t.Error("presentAlternatives() = empty, want alternative for dirty file")
	}
	if !strings.Contains(result, "handler.go") {
		t.Errorf("alternative missing filename, got: %s", result)
	}
	if !strings.Contains(result, "feature/auth") {
		t.Errorf("alternative missing branch, got: %s", result)
	}
}

func TestAlternativesNoDirtyFiles(t *testing.T) {
	t.Parallel()

	sessionID := "test-git-no-dirty"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// No dirty files set — editing any file should not produce git-related alternatives.
	// (May still produce stale-read alternative since file hasn't been Read.)
	input := json.RawMessage(`{"file_path":"/project/main.go"}`)
	result := presentAlternatives(sdb, "Edit", input)
	if strings.Contains(result, "Commit/stash") {
		t.Errorf("presentAlternatives() with no dirty files should not suggest commit/stash, got: %s", result)
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
