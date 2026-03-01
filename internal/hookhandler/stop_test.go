package hookhandler

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

func openStopTestDB(t *testing.T) (string, *sessiondb.SessionDB) {
	t.Helper()
	id := "test-stop-" + t.Name()
	sdb, err := sessiondb.Open(id)
	if err != nil {
		t.Fatalf("sessiondb.Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return id, sdb
}

func makeStopInput(t *testing.T, sessionID, msg string) []byte {
	t.Helper()
	in := stopInput{
		CommonInput:          CommonInput{SessionID: sessionID},
		LastAssistantMessage: msg,
	}
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("json.Marshal() = %v", err)
	}
	return data
}

func TestHandleStop_EmptyMessage(t *testing.T) {
	t.Parallel()
	id, _ := openStopTestDB(t)
	input := makeStopInput(t, id, "")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	if output != nil {
		t.Errorf("handleStop(empty) = %+v, want nil", output)
	}
}

func TestHandleStop_CleanCompletion(t *testing.T) {
	t.Parallel()
	id, _ := openStopTestDB(t)
	input := makeStopInput(t, id, "All tasks completed successfully. Tests pass and build is clean.")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	if output != nil {
		t.Errorf("handleStop(clean) = %+v, want nil (no block)", output)
	}
}

func TestHandleStop_SingleTodoNoBlock(t *testing.T) {
	t.Parallel()
	// Single text signal → SystemMessage soft warning, not block.
	id, _ := openStopTestDB(t)
	input := makeStopInput(t, id, "Implementation complete. TODO: add edge case tests later.")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	if output != nil && output.Decision == "block" {
		t.Error("handleStop(single TODO) should not block, want soft warning only")
	}
	if output == nil || output.SystemMessage == "" {
		t.Error("single signal should return SystemMessage as soft warning")
	}
}

func TestHandleStop_UnresolvedFailure(t *testing.T) {
	t.Parallel()
	id, sdb := openStopTestDB(t)
	_ = sdb.RecordFailure("Bash", "test", "build error: undefined func", "main.go")
	input := makeStopInput(t, id, "I've made some changes to main.go.")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	if output == nil || output.Decision != "block" {
		t.Errorf("handleStop(unresolved failure) should block, got %+v", output)
	}
}

func TestHandleStop_MultipleSignals(t *testing.T) {
	t.Parallel()
	id, _ := openStopTestDB(t)
	input := makeStopInput(t, id, "TODO: fix the remaining test failures. The build is still failing.")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	if output == nil || output.Decision != "block" {
		t.Errorf("handleStop(multiple signals) should block, got %+v", output)
	}
}

func TestHandleStop_Japanese(t *testing.T) {
	// Japanese incomplete + placeholder → 2 signals → block.
	t.Parallel()
	id, _ := openStopTestDB(t)
	input := makeStopInput(t, id, "実装完了。残りのテストは後で追加します。TODO: エッジケース")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	// "残り" (incompletePatterns) + "TODO" (placeholderPatterns) = 2 signals → block.
	if output == nil || output.Decision != "block" {
		t.Errorf("handleStop(Japanese+TODO) should block, got %+v", output)
	}
}

func TestHandleStop_StopHookActiveAllowsExit(t *testing.T) {
	t.Parallel()
	id, sdb := openStopTestDB(t)
	_ = sdb.RecordFailure("Bash", "test", "build error: undefined func", "main.go")

	// First attempt without stop_hook_active should block.
	input := makeStopInput(t, id, "I've made some changes to main.go.")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("attempt 1: handleStop() error = %v", err)
	}
	if output == nil || output.Decision != "block" {
		t.Fatalf("attempt 1: should block, got %+v", output)
	}

	// Second attempt with stop_hook_active=true should allow exit.
	in := stopInput{
		CommonInput:          CommonInput{SessionID: id},
		LastAssistantMessage: "I've made some changes to main.go.",
		StopHookActive:       true,
	}
	data, _ := json.Marshal(in)
	output, err = handleStop(data)
	if err != nil {
		t.Fatalf("attempt 2 (active): handleStop() error = %v", err)
	}
	if output != nil {
		t.Errorf("handleStop(stop_hook_active=true) should allow exit, got %+v", output)
	}
}

func TestHandleStop_ExploreTaskTypeSkipsFailures(t *testing.T) {
	t.Parallel()
	id, sdb := openStopTestDB(t)
	_ = sdb.SetContext("task_type", "explore")
	_ = sdb.RecordFailure("Bash", "test", "build error: undefined func", "main.go")

	input := makeStopInput(t, id, "I've made some changes to main.go.")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	if output != nil && output.Decision == "block" {
		t.Error("handleStop(explore task) should not block on unresolved failures")
	}
}

func TestHandleStop_BlockHasSystemMessage(t *testing.T) {
	t.Parallel()
	id, sdb := openStopTestDB(t)
	_ = sdb.RecordFailure("Bash", "test", "build error: undefined func", "main.go")
	input := makeStopInput(t, id, "I've made some changes to main.go.")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	if output == nil || output.Decision != "block" {
		t.Fatalf("should block, got %+v", output)
	}
	if output.SystemMessage == "" {
		t.Error("block output should have SystemMessage with actionable instructions")
	}
	if !strings.Contains(output.SystemMessage, "main.go") {
		t.Errorf("SystemMessage should mention the failing file, got: %s", output.SystemMessage)
	}
}

func TestHandleStop_SingleSignalUsesSystemMessage(t *testing.T) {
	t.Parallel()
	// Single incompletePattern signal → SystemMessage (not nil output).
	id, _ := openStopTestDB(t)
	input := makeStopInput(t, id, "Most of the work is done. The remaining items are minor.")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	if output != nil && output.Decision == "block" {
		t.Error("single signal should not block")
	}
	if output == nil || output.SystemMessage == "" {
		t.Error("single signal should return SystemMessage as soft warning")
	}
}

func TestActionForFailure(t *testing.T) {
	t.Parallel()
	tests := []struct {
		failType string
		filePath string
		errorSig string
		want     string
	}{
		{"test_failure", "/path/to/main.go", "undefined: Foo", "Run tests to verify main.go"},
		{"compile_error", "/path/to/handler.go", "syntax error", "Fix compile error in handler.go"},
		{"edit_mismatch", "/path/to/config.go", "", "Re-read config.go before editing"},
		{"unknown", "/path/to/file.go", "something failed", "Resolve failure in file.go"},
		{"unknown_empty_sig", "/path/to/empty.go", "", "Resolve failure in empty.go"},
	}
	for _, tt := range tests {
		t.Run(tt.failType, func(t *testing.T) {
			t.Parallel()
			got := actionForFailure(tt.failType, tt.filePath, tt.errorSig)
			if !strings.Contains(got, filepath.Base(tt.filePath)) {
				t.Errorf("actionForFailure(%q) = %q, should contain filename", tt.failType, got)
			}
			if strings.HasSuffix(got, ": ") {
				t.Errorf("actionForFailure(%q) = %q, should not end with trailing ': '", tt.failType, got)
			}
		})
	}
}

func TestHandleStop_JapaneseSingleSignal(t *testing.T) {
	t.Parallel()
	// Single Japanese signal → SystemMessage soft warning, no block.
	id, _ := openStopTestDB(t)
	input := makeStopInput(t, id, "実装完了。残りのテストは後で追加します。")
	output, err := handleStop(input)
	if err != nil {
		t.Fatalf("handleStop() error = %v", err)
	}
	// "残り" is detected (single signal) → no block.
	if output != nil && output.Decision == "block" {
		t.Error("handleStop(single Japanese signal) should not block")
	}
	if output == nil || output.SystemMessage == "" {
		t.Error("single Japanese signal should return SystemMessage as soft warning")
	}
}
