package store

import (
	"context"
	"path/filepath"
	"testing"
)

func openTestStore(tb testing.TB) *Store {
	tb.Helper()
	dir := tb.TempDir()
	st, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		tb.Fatalf("Open: %v", err)
	}
	tb.Cleanup(func() { st.Close() })
	return st
}

func TestUpsertAndGetKnowledge(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	row := &KnowledgeRow{
		FilePath:    "decisions/dec-001.md",
		Title:       "Use SQLite for storage",
		Content:     "Decided to use SQLite because it is embedded and reliable",
		SubType:     SubTypeDecision,
		ProjectPath: "/test/project",
		ProjectName: "test-project",
	}

	id, changed, err := st.UpsertKnowledge(ctx, row)
	if err != nil {
		t.Fatalf("UpsertKnowledge: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for new entry")
	}
	if id == 0 {
		t.Error("expected non-zero ID")
	}

	// Get by ID.
	got, err := st.GetKnowledgeByID(ctx, id)
	if err != nil {
		t.Fatalf("GetKnowledgeByID: %v", err)
	}
	if got.Title != "Use SQLite for storage" {
		t.Errorf("Title = %q, want %q", got.Title, "Use SQLite for storage")
	}
	if got.SubType != SubTypeDecision {
		t.Errorf("SubType = %q, want %q", got.SubType, SubTypeDecision)
	}

	// Upsert again with same content — should not change.
	_, changed, err = st.UpsertKnowledge(ctx, row)
	if err != nil {
		t.Fatalf("UpsertKnowledge (same): %v", err)
	}
	if changed {
		t.Error("expected changed=false for unchanged content")
	}

	// Upsert with different content — should change.
	row.Content = "Updated decision: use SQLite with WAL mode"
	_, changed, err = st.UpsertKnowledge(ctx, row)
	if err != nil {
		t.Fatalf("UpsertKnowledge (updated): %v", err)
	}
	if !changed {
		t.Error("expected changed=true for updated content")
	}
}

func TestListKnowledge(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	for i, title := range []string{"First", "Second", "Third"} {
		_, _, err := st.UpsertKnowledge(ctx, &KnowledgeRow{
			FilePath:    "decisions/dec-00" + string(rune('1'+i)) + ".md",
			Title:       title,
			Content:     "Content for " + title,
			SubType:     SubTypeDecision,
			ProjectPath: "/test",
		})
		if err != nil {
			t.Fatalf("UpsertKnowledge %s: %v", title, err)
		}
	}

	rows, err := st.ListKnowledge(ctx, "", "/test", 10)
	if err != nil {
		t.Fatalf("ListKnowledge: %v", err)
	}
	if len(rows) != 3 {
		t.Errorf("ListKnowledge = %d rows, want 3", len(rows))
	}
}

func TestDeleteKnowledge(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	id, _, err := st.UpsertKnowledge(ctx, &KnowledgeRow{
		FilePath:    "patterns/pat-001.md",
		Title:       "Error handling pattern",
		Content:     "Always return errors, never swallow",
		SubType:     SubTypePattern,
		ProjectPath: "/test",
	})
	if err != nil {
		t.Fatalf("UpsertKnowledge: %v", err)
	}

	if err := st.DeleteKnowledge(ctx, id); err != nil {
		t.Fatalf("DeleteKnowledge: %v", err)
	}

	_, err = st.GetKnowledgeByID(ctx, id)
	if err == nil {
		t.Error("expected error getting deleted knowledge")
	}
}

func TestSetKnowledgeEnabled(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	id, _, _ := st.UpsertKnowledge(ctx, &KnowledgeRow{
		FilePath:    "rules/rul-001.md",
		Title:       "No mock DB",
		Content:     "Integration tests must use real database",
		SubType:     SubTypeRule,
		ProjectPath: "/test",
	})

	if err := st.SetKnowledgeEnabled(ctx, id, false); err != nil {
		t.Fatalf("SetKnowledgeEnabled(false): %v", err)
	}

	// Disabled entries should not appear in ListKnowledge.
	rows, _ := st.ListKnowledge(ctx, "", "/test", 10)
	if len(rows) != 0 {
		t.Errorf("ListKnowledge after disable = %d, want 0", len(rows))
	}

	// But should appear in ListAllKnowledge.
	all, _ := st.ListAllKnowledge(ctx, "", "/test", 10)
	if len(all) != 1 {
		t.Errorf("ListAllKnowledge after disable = %d, want 1", len(all))
	}
}

func TestPromoteSubType(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	id, _, _ := st.UpsertKnowledge(ctx, &KnowledgeRow{
		FilePath:    "decisions/dec-promote.md",
		Title:       "Promotable",
		Content:     "This should be promoted",
		SubType:     SubTypeGeneral,
		ProjectPath: "/test",
	})

	if err := st.PromoteSubType(ctx, id, SubTypePattern); err != nil {
		t.Fatalf("PromoteSubType: %v", err)
	}

	row, _ := st.GetKnowledgeByID(ctx, id)
	if row.SubType != SubTypePattern {
		t.Errorf("SubType after promote = %q, want %q", row.SubType, SubTypePattern)
	}
}

func TestSearchKnowledgeKeyword(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	st.UpsertKnowledge(ctx, &KnowledgeRow{
		FilePath:    "decisions/dec-search.md",
		Title:       "SQLite decision",
		Content:     "We chose SQLite for its embedded nature",
		SubType:     SubTypeDecision,
		ProjectPath: "/test",
	})

	results, err := st.SearchKnowledgeKeyword(ctx, "SQLite", 10)
	if err != nil {
		t.Fatalf("SearchKnowledgeKeyword: %v", err)
	}
	if len(results) == 0 {
		t.Error("expected at least 1 result for 'SQLite'")
	}
}

func TestCountKnowledge(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	st.UpsertKnowledge(ctx, &KnowledgeRow{
		FilePath: "decisions/dec-count.md", Title: "A", Content: "A",
		SubType: SubTypeDecision, ProjectPath: "/test",
	})
	st.UpsertKnowledge(ctx, &KnowledgeRow{
		FilePath: "patterns/pat-count.md", Title: "B", Content: "B",
		SubType: SubTypePattern, ProjectPath: "/test",
	})

	count, err := st.CountKnowledge(ctx, "", "/test")
	if err != nil {
		t.Fatalf("CountKnowledge: %v", err)
	}
	if count != 2 {
		t.Errorf("CountKnowledge = %d, want 2", count)
	}
}

func TestProjectDetection(t *testing.T) {
	t.Parallel()

	t.Run("normalize SSH remote", func(t *testing.T) {
		got := normalizeRemoteURL("git@github.com:user/repo.git")
		if got != "github.com/user/repo" {
			t.Errorf("normalizeRemoteURL(SSH) = %q, want github.com/user/repo", got)
		}
	})

	t.Run("normalize HTTPS remote", func(t *testing.T) {
		got := normalizeRemoteURL("https://github.com/user/repo.git")
		if got != "github.com/user/repo" {
			t.Errorf("normalizeRemoteURL(HTTPS) = %q, want github.com/user/repo", got)
		}
	})

	t.Run("repo name extraction", func(t *testing.T) {
		got := repoNameFromRemote("github.com/user/my-project")
		if got != "my-project" {
			t.Errorf("repoNameFromRemote = %q, want my-project", got)
		}
	})
}
