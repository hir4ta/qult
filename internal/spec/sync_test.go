package spec

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/store"
)

func TestSyncToDB(t *testing.T) {
	projectDir := t.TempDir()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	sd, err := Init(projectDir, "sync-test", "Test sync")
	if err != nil {
		t.Fatal(err)
	}

	// First sync: all upserted
	result, err := SyncToDB(context.Background(), sd, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != len(AllFiles) {
		t.Errorf("expected %d upserted, got %d", len(AllFiles), result.Upserted)
	}

	// Second sync: all unchanged
	result2, err := SyncToDB(context.Background(), sd, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result2.Unchanged != len(AllFiles) {
		t.Errorf("expected %d unchanged, got %d", len(AllFiles), result2.Unchanged)
	}

	// Modify and re-sync: 1 upserted
	if err := sd.AppendFile(FileDecisions, "## New decision\n"); err != nil {
		t.Fatal(err)
	}
	result3, err := SyncToDB(context.Background(), sd, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result3.Upserted != 1 {
		t.Errorf("expected 1 upserted after change, got %d", result3.Upserted)
	}
}

func TestSyncSingleFile(t *testing.T) {
	projectDir := t.TempDir()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	sd, err := Init(projectDir, "single-sync", "Test")
	if err != nil {
		t.Fatal(err)
	}

	err = SyncSingleFile(context.Background(), sd, FileSession, st, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Verify searchable via FTS
	docs, err := st.SearchDocsFTS("Session single-sync", "spec", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) == 0 {
		t.Error("expected to find synced doc via FTS search")
	}
}
