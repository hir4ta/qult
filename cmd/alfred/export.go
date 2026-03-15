package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// exportedMemory is the YAML schema for exported memories.
type exportedMemory struct {
	Label     string `yaml:"label"`
	Content   string `yaml:"content"`
	SavedAt   string `yaml:"saved_at"`
	SourceURL string `yaml:"source_url"`
}

// runExport exports all memories to .alfred/knowledge/ as YAML files.
// These files are Git-shareable (not gitignored).
func runExport() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Fetch all memory records.
	docs, err := st.SearchMemoriesKeyword(ctx, "", 1000)
	if err != nil {
		return fmt.Errorf("fetch memories: %w", err)
	}

	if len(docs) == 0 {
		fmt.Println("No memories to export.")
		return nil
	}

	// Determine output directory.
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get cwd: %w", err)
	}
	outDir := filepath.Join(cwd, ".alfred", "knowledge")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("create knowledge dir: %w", err)
	}

	// Export as a single YAML file with all memories.
	var memories []exportedMemory
	for _, d := range docs {
		memories = append(memories, exportedMemory{
			Label:     d.SectionPath,
			Content:   d.Content,
			SavedAt:   d.CrawledAt,
			SourceURL: d.URL,
		})
	}

	data, err := yaml.Marshal(memories)
	if err != nil {
		return fmt.Errorf("marshal yaml: %w", err)
	}

	outPath := filepath.Join(outDir, "memories.yaml")
	if err := os.WriteFile(outPath, data, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", outPath, err)
	}

	fmt.Printf("Exported %d memories to %s\n", len(memories), outPath)
	return nil
}
