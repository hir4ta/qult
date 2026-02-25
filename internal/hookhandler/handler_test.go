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

func TestDetector_RetryLoop(t *testing.T) {
	t.Parallel()

	sessionID := "test-detector-retry"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Record 3 identical events.
	for range 3 {
		_ = sdb.RecordEvent("Bash", 12345, false)
	}

	det := &HookDetector{sdb: sdb}
	det.detectRetryLoop()

	nudges, _ := sdb.DequeueNudges(5)
	if len(nudges) != 1 {
		t.Fatalf("detectRetryLoop() generated %d nudges, want 1", len(nudges))
	}
	if nudges[0].Pattern != "retry-loop" {
		t.Errorf("nudge.Pattern = %q, want retry-loop", nudges[0].Pattern)
	}
}

func TestDetector_RetryLoop_NoCooldownDuplicate(t *testing.T) {
	t.Parallel()

	sessionID := "test-detector-retry-cooldown"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Record 3 identical events and detect.
	for range 3 {
		_ = sdb.RecordEvent("Bash", 99999, false)
	}
	det := &HookDetector{sdb: sdb}
	det.detectRetryLoop()

	// Drain nudges.
	sdb.DequeueNudges(5)

	// Record more and detect again — should be on cooldown.
	for range 3 {
		_ = sdb.RecordEvent("Bash", 99999, false)
	}
	det.detectRetryLoop()

	nudges, _ := sdb.DequeueNudges(5)
	if len(nudges) != 0 {
		t.Errorf("detectRetryLoop() should not fire on cooldown, got %d nudges", len(nudges))
	}
}

func TestDetector_ExcessiveTools(t *testing.T) {
	t.Parallel()

	sessionID := "test-detector-excessive"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Record 25 events to trigger threshold.
	for i := range 25 {
		_ = sdb.RecordEvent("Read", uint64(i), false)
	}

	det := &HookDetector{sdb: sdb}
	det.detectExcessiveTools()

	nudges, _ := sdb.DequeueNudges(5)
	if len(nudges) != 1 {
		t.Fatalf("detectExcessiveTools() at 25 = %d nudges, want 1", len(nudges))
	}
	if nudges[0].Level != "warn" {
		t.Errorf("nudge.Level = %q, want warn", nudges[0].Level)
	}
}

func TestDetector_FileReadLoop(t *testing.T) {
	t.Parallel()

	sessionID := "test-detector-file-read"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Read same file 5 times without writing.
	for range 5 {
		_ = sdb.IncrementFileRead("/src/main.go")
		_ = sdb.RecordEvent("Read", 111, false)
	}

	det := &HookDetector{sdb: sdb}
	det.detectFileReadLoop()

	nudges, _ := sdb.DequeueNudges(5)
	if len(nudges) != 1 {
		t.Fatalf("detectFileReadLoop() = %d nudges, want 1", len(nudges))
	}
	if nudges[0].Pattern != "file-read-loop" {
		t.Errorf("nudge.Pattern = %q, want file-read-loop", nudges[0].Pattern)
	}
}

func TestDetector_FileReadLoop_SuppressedByWrite(t *testing.T) {
	t.Parallel()

	sessionID := "test-detector-file-read-write"
	sdb, err := sessiondb.Open(sessionID)
	if err != nil {
		t.Fatalf("sessiondb.Open() = %v", err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })

	// Read same file 5 times but also perform a write.
	for range 5 {
		_ = sdb.IncrementFileRead("/src/main.go")
		_ = sdb.RecordEvent("Read", 111, false)
	}
	_ = sdb.RecordEvent("Write", 222, true)

	det := &HookDetector{sdb: sdb}
	det.detectFileReadLoop()

	nudges, _ := sdb.DequeueNudges(5)
	if len(nudges) != 0 {
		t.Errorf("detectFileReadLoop() with write present = %d nudges, want 0", len(nudges))
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
