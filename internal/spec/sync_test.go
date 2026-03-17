package spec

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/store"
)

func TestSyncToDB_NoOp(t *testing.T) {
	projectDir := t.TempDir()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	sd, err := Init(projectDir, "sync-test", "Test sync", WithSize(SizeS))
	if err != nil {
		t.Fatal(err)
	}

	// SyncToDB is a no-op in V8 — should return empty result without error.
	result, err := SyncToDB(context.Background(), sd, st, nil)
	if err != nil {
		t.Fatalf("SyncToDB: %v", err)
	}
	if result.Upserted != 0 || result.Embedded != 0 || result.Unchanged != 0 {
		t.Errorf("expected all zeros, got %+v", result)
	}
}
