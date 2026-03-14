package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

func TestLoadSpecContext(t *testing.T) {
	t.Run("no active spec returns nil", func(t *testing.T) {
		dir := t.TempDir()
		sc := loadSpecContext(dir)
		if sc != nil {
			t.Fatal("expected nil for project without spec")
		}
	})

	t.Run("active spec with session returns keywords", func(t *testing.T) {
		dir := t.TempDir()
		setupSpecWithSession(t, dir, "test-task", `# Session: test-task

## Status
active

## Currently Working On
Implementing FTS search pipeline with vector embeddings

## Next Steps
- [ ] Add reranking support
- [ ] Write integration tests
`)
		sc := loadSpecContext(dir)
		if sc == nil {
			t.Fatal("expected non-nil specContext")
		}
		if len(sc.keywords) == 0 {
			t.Fatal("expected keywords from session context")
		}
	})

	t.Run("empty working on returns nil", func(t *testing.T) {
		dir := t.TempDir()
		setupSpecWithSession(t, dir, "empty-task", `# Session: empty-task

## Status
active

## Currently Working On

## Next Steps
`)
		sc := loadSpecContext(dir)
		if sc != nil {
			t.Fatal("expected nil for empty session context")
		}
	})
}

func TestApplyContextBoost(t *testing.T) {
	t.Run("nil context is no-op", func(t *testing.T) {
		candidates := []scored{
			{doc: store.DocRow{Content: "some content", SectionPath: "a > b"}, score: 0.50},
		}
		boosted := applyContextBoost(candidates, nil)
		if len(boosted) != 0 {
			t.Fatalf("expected 0 boosted, got %d", len(boosted))
		}
		if candidates[0].score != 0.50 {
			t.Fatalf("expected score unchanged, got %.2f", candidates[0].score)
		}
	})

	t.Run("boosts candidates with keyword hits", func(t *testing.T) {
		sc := &specContext{keywords: []string{"search", "pipeline"}}
		candidates := []scored{
			{doc: store.DocRow{ID: 1, Content: "search pipeline implementation guide", SectionPath: "docs > search"}, score: 0.50},
			{doc: store.DocRow{ID: 2, Content: "unrelated configuration topic", SectionPath: "docs > config"}, score: 0.48},
		}
		boosted := applyContextBoost(candidates, sc)
		if len(boosted) != 1 {
			t.Fatalf("expected 1 boosted, got %d", len(boosted))
		}
		if !boosted[1] {
			t.Fatal("expected doc ID 1 to be boosted")
		}
		if candidates[0].score <= 0.50 {
			t.Fatalf("expected first candidate boosted, got %.2f", candidates[0].score)
		}
		if candidates[1].score != 0.48 {
			t.Fatalf("expected second candidate unchanged, got %.2f", candidates[1].score)
		}
	})

	t.Run("respects tiebreaker range", func(t *testing.T) {
		sc := &specContext{keywords: []string{"hooks"}}
		candidates := []scored{
			{doc: store.DocRow{ID: 1, Content: "hooks reference guide", SectionPath: "docs > hooks"}, score: 0.70},
			{doc: store.DocRow{ID: 2, Content: "hooks configuration tips", SectionPath: "docs > hooks > config"}, score: 0.55},
		}
		boosted := applyContextBoost(candidates, sc)
		// Second candidate is 0.15 below top (> 0.10 tiebreaker range), so not boosted.
		if len(boosted) != 1 {
			t.Fatalf("expected 1 boosted (tiebreaker range), got %d", len(boosted))
		}
	})

	t.Run("boost capped at contextBoostCap", func(t *testing.T) {
		sc := &specContext{keywords: []string{"a", "b", "c"}}
		candidates := []scored{
			{doc: store.DocRow{ID: 1, Content: "a b c d e f", SectionPath: "a > b > c"}, score: 0.50},
		}
		applyContextBoost(candidates, sc)
		maxExpected := 0.50 + contextBoostCap
		if candidates[0].score > maxExpected+0.001 {
			t.Fatalf("expected score <= %.2f, got %.2f", maxExpected, candidates[0].score)
		}
	})
}

func TestApplyContextBoostEdgeCases(t *testing.T) {
	t.Run("empty candidates is no-op", func(t *testing.T) {
		sc := &specContext{keywords: []string{"test"}}
		boosted := applyContextBoost(nil, sc)
		if len(boosted) != 0 {
			t.Fatalf("expected 0 boosted for nil candidates, got %d", len(boosted))
		}
		boosted = applyContextBoost([]scored{}, sc)
		if len(boosted) != 0 {
			t.Fatalf("expected 0 boosted for empty candidates, got %d", len(boosted))
		}
	})

	t.Run("single candidate with keyword hit", func(t *testing.T) {
		sc := &specContext{keywords: []string{"hooks"}}
		candidates := []scored{
			{doc: store.DocRow{ID: 1, Content: "hooks reference", SectionPath: "docs"}, score: 0.45},
		}
		boosted := applyContextBoost(candidates, sc)
		if len(boosted) != 1 {
			t.Fatalf("expected 1 boosted, got %d", len(boosted))
		}
		if candidates[0].score <= 0.45 {
			t.Fatalf("expected boost, got %.2f", candidates[0].score)
		}
	})

	t.Run("all zero scores", func(t *testing.T) {
		sc := &specContext{keywords: []string{"test"}}
		candidates := []scored{
			{doc: store.DocRow{ID: 1, Content: "test content", SectionPath: "a"}, score: 0.0},
			{doc: store.DocRow{ID: 2, Content: "other content", SectionPath: "b"}, score: 0.0},
		}
		boosted := applyContextBoost(candidates, sc)
		// Both within tiebreaker range (0 - 0 = 0 < 0.10), first has keyword hit.
		if len(boosted) != 1 {
			t.Fatalf("expected 1 boosted, got %d", len(boosted))
		}
	})
}

func TestSearchSpecContext(t *testing.T) {
	t.Run("nil context returns nil", func(t *testing.T) {
		docs := searchSpecContext(context.Background(), nil, nil)
		if docs != nil {
			t.Fatal("expected nil for nil context")
		}
	})

	t.Run("empty keywords returns nil", func(t *testing.T) {
		sc := &specContext{keywords: []string{}}
		docs := searchSpecContext(context.Background(), sc, nil)
		if docs != nil {
			t.Fatal("expected nil for empty keywords")
		}
	})
}

// setupSpecWithSession creates a minimal spec directory with a session.md file.
func setupSpecWithSession(t *testing.T, projectDir, taskSlug, sessionContent string) {
	t.Helper()
	specDir := filepath.Join(projectDir, ".alfred", "specs", taskSlug)
	if err := os.MkdirAll(specDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Write session.md
	if err := os.WriteFile(filepath.Join(specDir, "session.md"), []byte(sessionContent), 0o644); err != nil {
		t.Fatal(err)
	}
	// Write _active.md
	activeContent := "primary: " + taskSlug + "\ntasks:\n  - slug: " + taskSlug + "\n"
	activeDir := filepath.Join(projectDir, ".alfred", "specs")
	if err := os.WriteFile(filepath.Join(activeDir, "_active.md"), []byte(activeContent), 0o644); err != nil {
		t.Fatal(err)
	}
	// Write minimal requirements.md so spec.Exists() works.
	if err := os.WriteFile(filepath.Join(specDir, string(spec.FileRequirements)), []byte("# Requirements\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}
