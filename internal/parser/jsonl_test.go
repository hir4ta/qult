package parser

import (
	"strings"
	"testing"
)

func TestParseUserMessageString(t *testing.T) {
	line := []byte(`{
		"type": "user",
		"uuid": "abc-123",
		"timestamp": "2026-02-24T10:00:00.000Z",
		"sessionId": "sess-001",
		"message": {
			"role": "user",
			"content": "このバグを直して"
		}
	}`)

	events, err := ParseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != EventUserMessage {
		t.Errorf("expected EventUserMessage, got %d", events[0].Type)
	}
	if events[0].UserText != "このバグを直して" {
		t.Errorf("expected user text 'このバグを直して', got %q", events[0].UserText)
	}
}

func TestParseUserMessageToolResult(t *testing.T) {
	// When content is a tool_result array, user text should be empty
	line := []byte(`{
		"type": "user",
		"uuid": "abc-456",
		"timestamp": "2026-02-24T10:01:00.000Z",
		"sessionId": "sess-001",
		"message": {
			"role": "user",
			"content": [
				{
					"tool_use_id": "toolu_123",
					"type": "tool_result",
					"content": "OK",
					"is_error": false
				}
			]
		}
	}`)

	events, err := ParseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events for tool_result, got %d", len(events))
	}
}

func TestParseAssistantWithToolUse(t *testing.T) {
	line := []byte(`{
		"type": "assistant",
		"uuid": "def-789",
		"timestamp": "2026-02-24T10:02:00.000Z",
		"sessionId": "sess-001",
		"message": {
			"role": "assistant",
			"model": "claude-opus-4-5-20251101",
			"content": [
				{
					"type": "thinking",
					"thinking": "Let me check the file..."
				},
				{
					"type": "text",
					"text": "ファイルを確認します。"
				},
				{
					"type": "tool_use",
					"id": "toolu_001",
					"name": "Read",
					"input": {
						"file_path": "/src/main.go"
					}
				},
				{
					"type": "tool_use",
					"id": "toolu_002",
					"name": "Bash",
					"input": {
						"command": "grep -r 'TODO' ./src",
						"description": "Search for TODO comments"
					}
				}
			]
		}
	}`)

	events, err := ParseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events (text + 2 tool_use), got %d", len(events))
	}

	// text
	if events[0].Type != EventAssistantText {
		t.Errorf("event[0]: expected AssistantText, got %d", events[0].Type)
	}
	if events[0].AssistantText != "ファイルを確認します。" {
		t.Errorf("event[0]: unexpected text %q", events[0].AssistantText)
	}

	// Read tool
	if events[1].Type != EventToolUse {
		t.Errorf("event[1]: expected ToolUse, got %d", events[1].Type)
	}
	if events[1].ToolName != "Read" {
		t.Errorf("event[1]: expected tool Read, got %q", events[1].ToolName)
	}
	if events[1].ToolInput != "/src/main.go" {
		t.Errorf("event[1]: expected input '/src/main.go', got %q", events[1].ToolInput)
	}

	// Bash tool — should use description over command
	if events[2].Type != EventToolUse {
		t.Errorf("event[2]: expected ToolUse, got %d", events[2].Type)
	}
	if events[2].ToolName != "Bash" {
		t.Errorf("event[2]: expected tool Bash, got %q", events[2].ToolName)
	}
	if events[2].ToolInput != "Search for TODO comments" {
		t.Errorf("event[2]: expected description, got %q", events[2].ToolInput)
	}
}

func TestParseProgressSkipped(t *testing.T) {
	line := []byte(`{
		"type": "progress",
		"uuid": "ghi-101",
		"timestamp": "2026-02-24T10:03:00.000Z",
		"sessionId": "sess-001",
		"data": {"type": "hook_progress"}
	}`)

	events, err := ParseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events for progress, got %d", len(events))
	}
}

func TestParseEmptyLine(t *testing.T) {
	events, err := ParseLine([]byte{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if events != nil {
		t.Fatalf("expected nil for empty line, got %v", events)
	}
}

func TestTruncate(t *testing.T) {
	long := "これは非常に長いテキストで、80文字を超える場合は末尾が省略記号に置き換えられるべきです。テストのためにさらに文字を追加します。もっと追加してテストを確実にパスさせます。さらにもう少し追加。"
	result := Truncate(long, 80)
	runes := []rune(result)
	if len(runes) > 80 {
		t.Errorf("truncated string too long: %d runes", len(runes))
	}
	if !strings.HasSuffix(result, "...") {
		t.Errorf("expected ... suffix, got %q", result)
	}
}

func TestParseSummaryMessage(t *testing.T) {
	line := []byte(`{
		"type": "summary",
		"summary": "The user asked to fix a bug in the login flow. I identified the issue in auth.go and applied a patch.",
		"leafUuid": "leaf-001"
	}`)

	events, err := ParseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != EventCompactBoundary {
		t.Errorf("expected EventCompactBoundary, got %d", events[0].Type)
	}
	if events[0].AssistantText != "The user asked to fix a bug in the login flow. I identified the issue in auth.go and applied a patch." {
		t.Errorf("unexpected summary text: %q", events[0].AssistantText)
	}
	if events[0].Timestamp.IsZero() {
		t.Error("expected non-zero timestamp for summary event")
	}
}

func TestParseSummaryMessageEmpty(t *testing.T) {
	line := []byte(`{
		"type": "summary",
		"summary": "",
		"leafUuid": "leaf-002"
	}`)

	events, err := ParseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events for empty summary, got %d", len(events))
	}
}

func TestParseLineRawUser(t *testing.T) {
	line := `{"type":"user","uuid":"u-001","timestamp":"2026-02-24T10:00:00.000Z","sessionId":"sess-001","message":{"role":"user","content":"hello"}}`

	pl := ParseLineRaw(line)
	if pl.RawType != "user" {
		t.Errorf("expected RawType 'user', got %q", pl.RawType)
	}
	if pl.UUID != "u-001" {
		t.Errorf("expected UUID 'u-001', got %q", pl.UUID)
	}
	if pl.RawJSON != line {
		t.Errorf("expected RawJSON to be original line for user message")
	}
	if pl.ByteLen != len(line) {
		t.Errorf("expected ByteLen %d, got %d", len(line), pl.ByteLen)
	}
	if len(pl.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(pl.Events))
	}
	if pl.Events[0].Type != EventUserMessage {
		t.Errorf("expected EventUserMessage, got %d", pl.Events[0].Type)
	}
}

func TestParseLineRawAssistant(t *testing.T) {
	line := `{"type":"assistant","uuid":"a-001","timestamp":"2026-02-24T10:01:00.000Z","sessionId":"sess-001","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}`

	pl := ParseLineRaw(line)
	if pl.RawType != "assistant" {
		t.Errorf("expected RawType 'assistant', got %q", pl.RawType)
	}
	if pl.UUID != "a-001" {
		t.Errorf("expected UUID 'a-001', got %q", pl.UUID)
	}
	if pl.RawJSON != line {
		t.Errorf("expected RawJSON to be original line for assistant message")
	}
	if len(pl.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(pl.Events))
	}
	if pl.Events[0].Type != EventAssistantText {
		t.Errorf("expected EventAssistantText, got %d", pl.Events[0].Type)
	}
}

func TestParseLineRawSummary(t *testing.T) {
	line := `{"type":"summary","summary":"Session context summary","leafUuid":"leaf-003"}`

	pl := ParseLineRaw(line)
	if pl.RawType != "summary" {
		t.Errorf("expected RawType 'summary', got %q", pl.RawType)
	}
	if pl.RawJSON != "" {
		t.Errorf("expected empty RawJSON for summary, got %q", pl.RawJSON)
	}
	if len(pl.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(pl.Events))
	}
	if pl.Events[0].Type != EventCompactBoundary {
		t.Errorf("expected EventCompactBoundary, got %d", pl.Events[0].Type)
	}
}

func TestParseLineRawToolResult(t *testing.T) {
	line := `{"type":"progress","uuid":"p-001","timestamp":"2026-02-24T10:03:00.000Z","sessionId":"sess-001","data":{"type":"hook_progress"}}`

	pl := ParseLineRaw(line)
	if pl.RawType != "progress" {
		t.Errorf("expected RawType 'progress', got %q", pl.RawType)
	}
	if pl.RawJSON != "" {
		t.Errorf("expected empty RawJSON for progress type, got %q", pl.RawJSON)
	}
	if len(pl.Events) != 0 {
		t.Fatalf("expected 0 events for progress, got %d", len(pl.Events))
	}
	if pl.ByteLen != len(line) {
		t.Errorf("expected ByteLen %d, got %d", len(line), pl.ByteLen)
	}
}

func TestParseLineRawEmpty(t *testing.T) {
	pl := ParseLineRaw("")
	if pl.RawType != "" {
		t.Errorf("expected empty RawType, got %q", pl.RawType)
	}
	if pl.ByteLen != 0 {
		t.Errorf("expected ByteLen 0, got %d", pl.ByteLen)
	}
	if pl.Events != nil {
		t.Errorf("expected nil Events, got %v", pl.Events)
	}
}

func TestParseTaskListOutput(t *testing.T) {
	// TaskList results appear as tool_result content in user messages
	line := []byte(`{
		"type": "user",
		"uuid": "tl-001",
		"timestamp": "2026-02-24T10:05:00.000Z",
		"sessionId": "sess-001",
		"message": {
			"role": "user",
			"content": [
				{
					"type": "tool_result",
					"tool_use_id": "toolu_tl1",
					"content": "#1 [completed] Store基盤: schema.go + store.go (store-builder)\n#2 [completed] パーサー拡張: EventCompactBoundary (parser-extender)\n#3 [in_progress] 同期エンジン: sync.go [blocked by #1, #2]\n#4 [pending] 設計判断抽出: decisions.go [blocked by #1]"
				}
			]
		}
	}`)

	events, err := ParseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 4 {
		t.Fatalf("expected 4 task update events, got %d", len(events))
	}

	// Task 1: completed
	if events[0].Type != EventTaskUpdate {
		t.Errorf("event[0]: expected EventTaskUpdate, got %d", events[0].Type)
	}
	if events[0].TaskID != "1" {
		t.Errorf("event[0]: expected TaskID '1', got %q", events[0].TaskID)
	}
	if events[0].TaskStatus != "completed" {
		t.Errorf("event[0]: expected status 'completed', got %q", events[0].TaskStatus)
	}
	if events[0].TaskSubject != "Store基盤: schema.go + store.go" {
		t.Errorf("event[0]: expected subject without owner, got %q", events[0].TaskSubject)
	}

	// Task 3: in_progress with blocked stripped
	if events[2].TaskID != "3" {
		t.Errorf("event[2]: expected TaskID '3', got %q", events[2].TaskID)
	}
	if events[2].TaskStatus != "in_progress" {
		t.Errorf("event[2]: expected status 'in_progress', got %q", events[2].TaskStatus)
	}
	if strings.Contains(events[2].TaskSubject, "blocked") {
		t.Errorf("event[2]: subject should not contain 'blocked', got %q", events[2].TaskSubject)
	}

	// Task 4: pending
	if events[3].TaskStatus != "pending" {
		t.Errorf("event[3]: expected status 'pending', got %q", events[3].TaskStatus)
	}
}

func TestParseTaskListOutputNoMatch(t *testing.T) {
	// Regular tool_result that doesn't contain TaskList output
	line := []byte(`{
		"type": "user",
		"uuid": "tl-002",
		"timestamp": "2026-02-24T10:06:00.000Z",
		"sessionId": "sess-001",
		"message": {
			"role": "user",
			"content": [
				{
					"type": "tool_result",
					"tool_use_id": "toolu_other",
					"content": "OK"
				}
			]
		}
	}`)

	events, err := ParseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events for non-TaskList result, got %d", len(events))
	}
}

func TestParseBashWithCommand(t *testing.T) {
	line := []byte(`{
		"type": "assistant",
		"uuid": "xyz-100",
		"timestamp": "2026-02-24T10:04:00.000Z",
		"sessionId": "sess-001",
		"message": {
			"role": "assistant",
			"content": [
				{
					"type": "tool_use",
					"id": "toolu_003",
					"name": "Bash",
					"input": {
						"command": "cat /etc/hosts"
					}
				}
			]
		}
	}`)

	events, err := ParseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	// No description → should fall back to command
	if events[0].ToolInput != "cat /etc/hosts" {
		t.Errorf("expected command as input, got %q", events[0].ToolInput)
	}
}
