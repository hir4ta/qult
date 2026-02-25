package hookhandler

import (
	"encoding/json"
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

	out, err := handlePostToolUse(data)
	if err != nil {
		t.Fatalf("handlePostToolUse() = %v", err)
	}
	if out != nil {
		t.Error("handlePostToolUse() should return nil (async)")
	}

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
		LastAssistantMessage: "I encountered an error: build failed when running go build",
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
		{name: "error explanation", msg: "I got error: cannot find module", wantIssue: false},
		{name: "build failed", msg: "The build failed with 3 errors", wantIssue: false},
		{name: "todo marker", msg: "Added a TODO: fix this later", wantIssue: true},
		{name: "incomplete ja", msg: "まだ完了していませんが、ここまで進めました", wantIssue: true},
		{name: "placeholder", msg: "I left a placeholder for the auth logic", wantIssue: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			issues := checkCompleteness(tt.msg)
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

func TestFormatResumeContext_Nil(t *testing.T) {
	t.Parallel()

	if result := FormatResumeContext(nil); result != "" {
		t.Errorf("FormatResumeContext(nil) = %q, want empty", result)
	}
	if result := FormatResumeContext(&ResumeData{}); result != "" {
		t.Errorf("FormatResumeContext(empty) = %q, want empty", result)
	}
}
