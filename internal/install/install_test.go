package install

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpdateClaudeMD_CreatesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".claude", "CLAUDE.md")

	if err := updateClaudeMDAt(path); err != nil {
		t.Fatalf("first call failed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}

	if !strings.Contains(string(data), claudeMDMarker) {
		t.Error("marker not found in file")
	}
}

func TestUpdateClaudeMD_Idempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".claude", "CLAUDE.md")

	// Write some existing content first.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("# Existing Content\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// First update.
	if err := updateClaudeMDAt(path); err != nil {
		t.Fatalf("first call failed: %v", err)
	}

	data1, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	// Second update (should be no-op).
	if err := updateClaudeMDAt(path); err != nil {
		t.Fatalf("second call failed: %v", err)
	}

	data2, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	if string(data1) != string(data2) {
		t.Error("file was modified on second call; expected idempotent behavior")
	}

	count := strings.Count(string(data2), claudeMDMarker)
	if count != 1 {
		t.Errorf("marker appears %d times, want 1", count)
	}
}

func TestUpdateClaudeMD_PreservesExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".claude", "CLAUDE.md")

	existing := "# My Config\nSome important rules\n"
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := updateClaudeMDAt(path); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.HasPrefix(string(data), existing) {
		t.Error("existing content was not preserved")
	}
	if !strings.Contains(string(data), claudeMDMarker) {
		t.Error("marker not appended")
	}
}
