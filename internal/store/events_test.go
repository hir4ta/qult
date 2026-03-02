package store

import (
	"testing"
)

func TestGetCoChangedFiles(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// Create two sessions.
	for _, id := range []string{"s1", "s2"} {
		st.UpsertSession(&SessionRow{
			ID: id, ProjectPath: "/proj/a", ProjectName: "a",
			JSONLPath: "/a/" + id + ".jsonl",
		})
	}

	// Session s1: edit main.go, handler.go, store.go
	for _, f := range []string{"/proj/a/main.go", "/proj/a/handler.go", "/proj/a/store.go"} {
		st.InsertEvent(&EventRow{
			SessionID: "s1", EventType: 2, Timestamp: "2025-01-01T00:00:00Z",
			ToolName: "Edit", ToolInput: f,
		})
	}

	// Session s2: edit main.go, handler.go (but not store.go)
	for _, f := range []string{"/proj/a/main.go", "/proj/a/handler.go"} {
		st.InsertEvent(&EventRow{
			SessionID: "s2", EventType: 2, Timestamp: "2025-01-02T00:00:00Z",
			ToolName: "Edit", ToolInput: f,
		})
	}

	// Co-changes with main.go: handler.go (2 sessions), store.go (1 session).
	results, err := st.GetCoChangedFiles("/proj/a/main.go", 10)
	if err != nil {
		t.Fatalf("GetCoChangedFiles: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("got %d co-changed files, want 2", len(results))
	}
	if results[0].Path != "/proj/a/handler.go" {
		t.Errorf("results[0].Path = %q, want /proj/a/handler.go", results[0].Path)
	}
	if results[0].Count != 2 {
		t.Errorf("results[0].Count = %d, want 2", results[0].Count)
	}
	if results[1].Path != "/proj/a/store.go" {
		t.Errorf("results[1].Path = %q, want /proj/a/store.go", results[1].Path)
	}
	if results[1].Count != 1 {
		t.Errorf("results[1].Count = %d, want 1", results[1].Count)
	}
}

func TestGetCoChangedFiles_SuffixDisambiguation(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	st.UpsertSession(&SessionRow{
		ID: "s1", ProjectPath: "/proj/a", ProjectName: "a",
		JSONLPath: "/a/s1.jsonl",
	})

	// Two different model.go files in different directories.
	for _, f := range []string{"/proj/a/internal/store/model.go", "/proj/a/internal/store/helper.go"} {
		st.InsertEvent(&EventRow{
			SessionID: "s1", EventType: 2, Timestamp: "2025-01-01T00:00:00Z",
			ToolName: "Edit", ToolInput: f,
		})
	}

	st.UpsertSession(&SessionRow{
		ID: "s2", ProjectPath: "/proj/a", ProjectName: "a",
		JSONLPath: "/a/s2.jsonl",
	})
	for _, f := range []string{"/proj/a/internal/tui/model.go", "/proj/a/internal/tui/view.go"} {
		st.InsertEvent(&EventRow{
			SessionID: "s2", EventType: 2, Timestamp: "2025-01-02T00:00:00Z",
			ToolName: "Edit", ToolInput: f,
		})
	}

	// Querying store/model.go should find helper.go, not tui/view.go.
	results, err := st.GetCoChangedFiles("/proj/a/internal/store/model.go", 10)
	if err != nil {
		t.Fatalf("GetCoChangedFiles: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d co-changed files, want 1", len(results))
	}
	if results[0].Path != "/proj/a/internal/store/helper.go" {
		t.Errorf("results[0].Path = %q, want store/helper.go", results[0].Path)
	}
}

func TestGetCoChangedFiles_Nonexistent(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	results, err := st.GetCoChangedFiles("/does/not/exist.go", 5)
	if err != nil {
		t.Fatalf("GetCoChangedFiles: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("got %d results for nonexistent file, want 0", len(results))
	}
}

func TestGetCoChangedFiles_Limit(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	st.UpsertSession(&SessionRow{
		ID: "s1", ProjectPath: "/proj/a", ProjectName: "a",
		JSONLPath: "/a/s1.jsonl",
	})

	// Edit target + 3 other files in same session.
	for _, f := range []string{"/proj/a/target.go", "/proj/a/a.go", "/proj/a/b.go", "/proj/a/c.go"} {
		st.InsertEvent(&EventRow{
			SessionID: "s1", EventType: 2, Timestamp: "2025-01-01T00:00:00Z",
			ToolName: "Write", ToolInput: f,
		})
	}

	results, err := st.GetCoChangedFiles("/proj/a/target.go", 2)
	if err != nil {
		t.Fatalf("GetCoChangedFiles: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("got %d results with limit=2, want 2", len(results))
	}
}
