package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hir4ta/claude-alfred/internal/parser"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestInsertEventAndGetRecent(t *testing.T) {
	s := newTestStore(t)

	// Create session first
	err := s.UpsertSession(&SessionRow{
		ID: "sess1", ProjectPath: "/tmp", ProjectName: "test", JSONLPath: "/tmp/sess1.jsonl",
	})
	if err != nil {
		t.Fatalf("UpsertSession: %v", err)
	}

	// Insert events
	ids := make([]int64, 3)
	for i := 0; i < 3; i++ {
		id, err := s.InsertEvent(&EventRow{
			SessionID: "sess1",
			EventType: int(parser.EventUserMessage),
			Timestamp: time.Now().Add(time.Duration(i) * time.Minute).UTC().Format(time.RFC3339),
			UserText:  "message " + string(rune('A'+i)),
		})
		if err != nil {
			t.Fatalf("InsertEvent %d: %v", i, err)
		}
		ids[i] = id
	}

	// Get recent
	events, err := s.GetRecentEvents("sess1", 10)
	if err != nil {
		t.Fatalf("GetRecentEvents: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}
	// Should be newest first
	if events[0].ID != ids[2] {
		t.Errorf("first event ID = %d, want %d", events[0].ID, ids[2])
	}
}

func TestSearchEvents(t *testing.T) {
	s := newTestStore(t)

	err := s.UpsertSession(&SessionRow{
		ID: "sess1", ProjectPath: "/tmp", ProjectName: "test", JSONLPath: "/tmp/sess1.jsonl",
	})
	if err != nil {
		t.Fatalf("UpsertSession: %v", err)
	}

	_, err = s.InsertEvent(&EventRow{
		SessionID: "sess1",
		EventType: int(parser.EventUserMessage),
		Timestamp: "2025-01-01T00:00:00Z",
		UserText:  "implement authentication module",
	})
	if err != nil {
		t.Fatalf("InsertEvent: %v", err)
	}

	_, err = s.InsertEvent(&EventRow{
		SessionID:      "sess1",
		EventType:      int(parser.EventAssistantText),
		Timestamp:      "2025-01-01T00:01:00Z",
		AssistantText:  "I will implement the database schema",
		CompactSegment: 1,
	})
	if err != nil {
		t.Fatalf("InsertEvent: %v", err)
	}

	// Search all segments
	results, total, err := s.SearchEvents("implement", "sess1", -1, 10)
	if err != nil {
		t.Fatalf("SearchEvents: %v", err)
	}
	if total != 2 {
		t.Errorf("total = %d, want 2", total)
	}
	if len(results) != 2 {
		t.Errorf("results = %d, want 2", len(results))
	}

	// Search segment 0 only
	results, total, err = s.SearchEvents("implement", "sess1", 0, 10)
	if err != nil {
		t.Fatalf("SearchEvents segment 0: %v", err)
	}
	if total != 1 {
		t.Errorf("segment 0 total = %d, want 1", total)
	}
	if len(results) != 1 {
		t.Errorf("segment 0 results = %d, want 1", len(results))
	}

	// Search by word only in assistant text
	results, _, err = s.SearchEvents("database", "sess1", -1, 10)
	if err != nil {
		t.Fatalf("SearchEvents database: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("database results = %d, want 1", len(results))
	}
}

func TestGetFilesModified(t *testing.T) {
	s := newTestStore(t)

	err := s.UpsertSession(&SessionRow{
		ID: "sess1", ProjectPath: "/tmp", ProjectName: "test", JSONLPath: "/tmp/sess1.jsonl",
	})
	if err != nil {
		t.Fatalf("UpsertSession: %v", err)
	}

	files := []struct {
		tool string
		path string
	}{
		{"Read", "/src/main.go"},
		{"Write", "/src/handler.go"},
		{"Edit", "/src/main.go"},
		{"Bash", "go test ./..."},
	}

	for _, f := range files {
		_, err := s.InsertEvent(&EventRow{
			SessionID: "sess1",
			EventType: int(parser.EventToolUse),
			Timestamp: "2025-01-01T00:00:00Z",
			ToolName:  f.tool,
			ToolInput: f.path,
		})
		if err != nil {
			t.Fatalf("InsertEvent: %v", err)
		}
	}

	paths, err := s.GetFilesModified("sess1", 10)
	if err != nil {
		t.Fatalf("GetFilesModified: %v", err)
	}
	// Should have 2 distinct paths (main.go and handler.go), no Bash
	if len(paths) != 2 {
		t.Errorf("got %d paths, want 2: %v", len(paths), paths)
	}
}

func TestUpsertSessionAndGet(t *testing.T) {
	s := newTestStore(t)

	sess := &SessionRow{
		ID:          "sess1",
		ProjectPath: "/Users/user/Projects/myapp",
		ProjectName: "myapp",
		JSONLPath:   "/home/user/.claude/projects/-Users-user-Projects-myapp/sess1.jsonl",
		TurnCount:   5,
		ToolUseCount: 10,
	}

	if err := s.UpsertSession(sess); err != nil {
		t.Fatalf("UpsertSession: %v", err)
	}

	got, err := s.GetSession("sess1")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.ProjectName != "myapp" {
		t.Errorf("ProjectName = %q, want %q", got.ProjectName, "myapp")
	}
	if got.TurnCount != 5 {
		t.Errorf("TurnCount = %d, want 5", got.TurnCount)
	}

	// Update
	sess.TurnCount = 8
	if err := s.UpsertSession(sess); err != nil {
		t.Fatalf("UpsertSession update: %v", err)
	}

	got, err = s.GetSession("sess1")
	if err != nil {
		t.Fatalf("GetSession after update: %v", err)
	}
	if got.TurnCount != 8 {
		t.Errorf("TurnCount after update = %d, want 8", got.TurnCount)
	}
}

func TestFindSessionByJSONLPath(t *testing.T) {
	s := newTestStore(t)

	if err := s.UpsertSession(&SessionRow{
		ID: "sess1", ProjectPath: "/tmp", ProjectName: "test",
		JSONLPath: "/path/to/sess1.jsonl",
	}); err != nil {
		t.Fatalf("UpsertSession: %v", err)
	}

	got, err := s.FindSessionByJSONLPath("/path/to/sess1.jsonl")
	if err != nil {
		t.Fatalf("FindSessionByJSONLPath: %v", err)
	}
	if got == nil {
		t.Fatal("expected session, got nil")
	}
	if got.ID != "sess1" {
		t.Errorf("ID = %q, want %q", got.ID, "sess1")
	}

	// Not found
	got, err = s.FindSessionByJSONLPath("/nonexistent.jsonl")
	if err != nil {
		t.Fatalf("FindSessionByJSONLPath (not found): %v", err)
	}
	if got != nil {
		t.Error("expected nil for nonexistent path")
	}
}

func TestGetLatestSession(t *testing.T) {
	s := newTestStore(t)

	sessions := []SessionRow{
		{ID: "s1", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s1.jsonl", LastEventAt: "2025-01-01T00:00:00Z"},
		{ID: "s2", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s2.jsonl", LastEventAt: "2025-01-02T00:00:00Z"},
		{ID: "s3", ProjectPath: "/proj/b", ProjectName: "b", JSONLPath: "/b/s3.jsonl", LastEventAt: "2025-01-03T00:00:00Z"},
	}
	for _, sess := range sessions {
		if err := s.UpsertSession(&sess); err != nil {
			t.Fatalf("UpsertSession: %v", err)
		}
	}

	// Latest globally
	got, err := s.GetLatestSession("")
	if err != nil {
		t.Fatalf("GetLatestSession global: %v", err)
	}
	if got.ID != "s3" {
		t.Errorf("latest global = %q, want %q", got.ID, "s3")
	}

	// Latest for project "a"
	got, err = s.GetLatestSession("a")
	if err != nil {
		t.Fatalf("GetLatestSession a: %v", err)
	}
	if got.ID != "s2" {
		t.Errorf("latest for a = %q, want %q", got.ID, "s2")
	}
}

func TestInsertCompactEventAndGet(t *testing.T) {
	s := newTestStore(t)

	if err := s.UpsertSession(&SessionRow{
		ID: "sess1", ProjectPath: "/tmp", ProjectName: "test", JSONLPath: "/tmp/sess1.jsonl",
	}); err != nil {
		t.Fatalf("UpsertSession: %v", err)
	}

	compacts := []CompactEventRow{
		{SessionID: "sess1", SegmentIndex: 0, SummaryText: "first compact", Timestamp: "2025-01-01T00:00:00Z", PreTurnCount: 5, PreToolCount: 10},
		{SessionID: "sess1", SegmentIndex: 1, SummaryText: "second compact", Timestamp: "2025-01-01T01:00:00Z", PreTurnCount: 10, PreToolCount: 20},
	}
	for _, ce := range compacts {
		if err := s.InsertCompactEvent(&ce); err != nil {
			t.Fatalf("InsertCompactEvent: %v", err)
		}
	}

	got, err := s.GetCompactEvents("sess1")
	if err != nil {
		t.Fatalf("GetCompactEvents: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d compacts, want 2", len(got))
	}
	if got[0].SummaryText != "first compact" {
		t.Errorf("first compact text = %q", got[0].SummaryText)
	}
	if got[1].PreTurnCount != 10 {
		t.Errorf("second compact pre_turn_count = %d, want 10", got[1].PreTurnCount)
	}
}

func TestUpdateSyncOffset(t *testing.T) {
	s := newTestStore(t)

	if err := s.UpsertSession(&SessionRow{
		ID: "sess1", ProjectPath: "/tmp", ProjectName: "test", JSONLPath: "/tmp/sess1.jsonl",
	}); err != nil {
		t.Fatalf("UpsertSession: %v", err)
	}

	if err := s.UpdateSyncOffset("sess1", 12345); err != nil {
		t.Fatalf("UpdateSyncOffset: %v", err)
	}

	got, err := s.GetSession("sess1")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.SyncedOffset != 12345 {
		t.Errorf("SyncedOffset = %d, want 12345", got.SyncedOffset)
	}
	if got.SyncedAt == "" {
		t.Error("SyncedAt should not be empty")
	}
}

func TestEstimateSessionChains(t *testing.T) {
	s := newTestStore(t)

	sessions := []SessionRow{
		{ID: "s1", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s1.jsonl",
			FirstEventAt: "2025-01-01T00:00:00Z", LastEventAt: "2025-01-01T01:00:00Z"},
		{ID: "s2", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s2.jsonl",
			FirstEventAt: "2025-01-01T02:00:00Z", LastEventAt: "2025-01-01T03:00:00Z"},
		{ID: "s3", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s3.jsonl",
			FirstEventAt: "2025-01-01T04:00:00Z", LastEventAt: "2025-01-01T05:00:00Z"},
		{ID: "s4", ProjectPath: "/proj/b", ProjectName: "b", JSONLPath: "/b/s4.jsonl",
			FirstEventAt: "2025-01-01T00:00:00Z", LastEventAt: "2025-01-01T01:00:00Z"},
	}
	for _, sess := range sessions {
		if err := s.UpsertSession(&sess); err != nil {
			t.Fatalf("UpsertSession: %v", err)
		}
	}

	if err := s.EstimateSessionChains(); err != nil {
		t.Fatalf("EstimateSessionChains: %v", err)
	}

	// s1 should have no parent (first in project a)
	s1, _ := s.GetSession("s1")
	if s1.ParentSessionID != "" {
		t.Errorf("s1 parent = %q, want empty", s1.ParentSessionID)
	}

	// s2 should have parent s1
	s2, _ := s.GetSession("s2")
	if s2.ParentSessionID != "s1" {
		t.Errorf("s2 parent = %q, want %q", s2.ParentSessionID, "s1")
	}

	// s3 should have parent s2
	s3, _ := s.GetSession("s3")
	if s3.ParentSessionID != "s2" {
		t.Errorf("s3 parent = %q, want %q", s3.ParentSessionID, "s2")
	}

	// s4 in different project, no parent
	s4, _ := s.GetSession("s4")
	if s4.ParentSessionID != "" {
		t.Errorf("s4 parent = %q, want empty", s4.ParentSessionID)
	}
}

func TestGetSessionChain(t *testing.T) {
	s := newTestStore(t)

	// Create chain: s1 <- s2 <- s3
	sessions := []SessionRow{
		{ID: "s1", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s1.jsonl",
			FirstEventAt: "2025-01-01T00:00:00Z"},
		{ID: "s2", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s2.jsonl",
			FirstEventAt: "2025-01-02T00:00:00Z", ParentSessionID: "s1"},
		{ID: "s3", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s3.jsonl",
			FirstEventAt: "2025-01-03T00:00:00Z", ParentSessionID: "s2"},
	}
	for _, sess := range sessions {
		if err := s.UpsertSession(&sess); err != nil {
			t.Fatalf("UpsertSession: %v", err)
		}
	}

	chain, err := s.GetSessionChain("s3")
	if err != nil {
		t.Fatalf("GetSessionChain: %v", err)
	}
	// Should include s3, s2, s1 ordered by first_event_at ASC
	if len(chain) < 2 {
		t.Fatalf("chain length = %d, want >= 2", len(chain))
	}
}

// makeJSONL builds a minimal JSONL line for testing.
func makeJSONL(typ, text string, ts time.Time) string {
	raw := parser.RawMessage{
		Type:      typ,
		Timestamp: ts.UTC().Format(time.RFC3339Nano),
	}

	switch typ {
	case "user":
		msg := map[string]interface{}{
			"role":    "user",
			"content": text,
		}
		msgBytes, _ := json.Marshal(msg)
		raw.Message = msgBytes

	case "assistant":
		items := []map[string]interface{}{
			{"type": "text", "text": text},
		}
		content, _ := json.Marshal(items)
		msg := map[string]interface{}{
			"role":    "assistant",
			"content": content,
		}
		msgBytes, _ := json.Marshal(msg)
		raw.Message = msgBytes

	case "summary":
		raw.Summary = text
	}

	b, _ := json.Marshal(raw)
	return string(b)
}

func TestSyncSession(t *testing.T) {
	s := newTestStore(t)

	// Create a fake JSONL file
	dir := t.TempDir()
	jsonlPath := filepath.Join(dir, "test-session-id.jsonl")

	now := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	lines := []string{
		makeJSONL("user", "hello world", now),
		makeJSONL("assistant", "hi there", now.Add(time.Second)),
		makeJSONL("user", "do something", now.Add(2*time.Second)),
		makeJSONL("summary", "context compacted", now.Add(3*time.Second)),
		makeJSONL("user", "after compact", now.Add(4*time.Second)),
	}

	content := ""
	for _, line := range lines {
		content += line + "\n"
	}
	if err := os.WriteFile(jsonlPath, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Sync
	if err := s.SyncSession(jsonlPath); err != nil {
		t.Fatalf("SyncSession: %v", err)
	}

	// Verify session was created
	sess, err := s.FindSessionByJSONLPath(jsonlPath)
	if err != nil {
		t.Fatalf("FindSessionByJSONLPath: %v", err)
	}
	if sess == nil {
		t.Fatal("session not created")
	}
	if sess.ID != "test-session-id" {
		t.Errorf("session ID = %q, want %q", sess.ID, "test-session-id")
	}

	// Verify turn count (3 user messages)
	if sess.TurnCount != 3 {
		t.Errorf("TurnCount = %d, want 3", sess.TurnCount)
	}

	// Verify compact count (1 summary)
	if sess.CompactCount != 1 {
		t.Errorf("CompactCount = %d, want 1", sess.CompactCount)
	}

	// Verify first prompt
	if sess.FirstPrompt != "hello world" {
		t.Errorf("FirstPrompt = %q, want %q", sess.FirstPrompt, "hello world")
	}

	// Verify compact events
	compacts, err := s.GetCompactEvents(sess.ID)
	if err != nil {
		t.Fatalf("GetCompactEvents: %v", err)
	}
	if len(compacts) != 1 {
		t.Fatalf("compact count = %d, want 1", len(compacts))
	}
	if compacts[0].SummaryText != "context compacted" {
		t.Errorf("compact summary = %q", compacts[0].SummaryText)
	}

	// Verify events are segmented
	events, err := s.GetRecentEvents(sess.ID, 100)
	if err != nil {
		t.Fatalf("GetRecentEvents: %v", err)
	}

	// Find the "after compact" event - should have compact_segment=1
	found := false
	for _, e := range events {
		if e.UserText == "after compact" {
			found = true
			if e.CompactSegment != 1 {
				t.Errorf("after-compact segment = %d, want 1", e.CompactSegment)
			}
		}
	}
	if !found {
		t.Error("after-compact event not found")
	}

	// Verify synced_offset is set
	if sess.SyncedOffset == 0 {
		t.Error("SyncedOffset should be > 0")
	}

	// Incremental sync: append more lines
	f, err := os.OpenFile(jsonlPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	newLine := makeJSONL("user", "incremental message", now.Add(5*time.Second))
	f.WriteString(newLine + "\n")
	f.Close()

	if err := s.SyncSession(jsonlPath); err != nil {
		t.Fatalf("SyncSession incremental: %v", err)
	}

	sess, _ = s.FindSessionByJSONLPath(jsonlPath)
	if sess.TurnCount != 4 {
		t.Errorf("TurnCount after incremental = %d, want 4", sess.TurnCount)
	}
}

func TestSyncSessionWithToolUse(t *testing.T) {
	s := newTestStore(t)

	dir := t.TempDir()
	jsonlPath := filepath.Join(dir, "tool-session.jsonl")

	now := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)

	// Build an assistant message with tool_use
	toolInput, _ := json.Marshal(map[string]string{"file_path": "/src/main.go"})
	items := []map[string]interface{}{
		{"type": "text", "text": "Let me read the file."},
		{"type": "tool_use", "id": "tu1", "name": "Read", "input": json.RawMessage(toolInput)},
	}
	content, _ := json.Marshal(items)
	msg := map[string]interface{}{
		"role":    "assistant",
		"content": json.RawMessage(content),
	}
	msgBytes, _ := json.Marshal(msg)
	raw := parser.RawMessage{
		Type:      "assistant",
		Timestamp: now.UTC().Format(time.RFC3339Nano),
	}
	raw.Message = msgBytes
	line, _ := json.Marshal(raw)

	if err := os.WriteFile(jsonlPath, append(line, '\n'), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if err := s.SyncSession(jsonlPath); err != nil {
		t.Fatalf("SyncSession: %v", err)
	}

	sess, _ := s.FindSessionByJSONLPath(jsonlPath)
	if sess.ToolUseCount != 1 {
		t.Errorf("ToolUseCount = %d, want 1", sess.ToolUseCount)
	}

	paths, err := s.GetFilesModified(sess.ID, 10)
	if err != nil {
		t.Fatalf("GetFilesModified: %v", err)
	}
	if len(paths) != 1 || paths[0] != "/src/main.go" {
		t.Errorf("files modified = %v, want [/src/main.go]", paths)
	}
}

func TestExtractSessionID(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/home/user/.claude/projects/foo/abc-def-123.jsonl", "abc-def-123"},
		{"/tmp/test.jsonl", "test"},
	}
	for _, tt := range tests {
		got := extractSessionID(tt.path)
		if got != tt.want {
			t.Errorf("extractSessionID(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestExtractProjectInfo(t *testing.T) {
	path := "/home/user/.claude/projects/-Users-user-Projects-myapp/sess1.jsonl"
	projPath, projName := extractProjectInfo(path)
	if projName != "myapp" {
		t.Errorf("projectName = %q, want %q", projName, "myapp")
	}
	if projPath != "/Users/user/Projects/myapp" {
		t.Errorf("projectPath = %q, want %q", projPath, "/Users/user/Projects/myapp")
	}
}
