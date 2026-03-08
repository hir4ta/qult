package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/hir4ta/claude-alfred/internal/store"
)

type exportDoc struct {
	URL         string `json:"url"`
	SectionPath string `json:"section_path"`
	Content     string `json:"content"`
	SourceType  string `json:"source_type"`
	CrawledAt   string `json:"crawled_at"`
}

type exportData struct {
	ExportedAt string      `json:"exported_at"`
	Version    string      `json:"version"`
	Memories   []exportDoc `json:"memories"`
	Specs      []exportDoc `json:"specs,omitempty"`
}

func runExport() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	ctx := context.Background()
	data := exportData{
		ExportedAt: time.Now().Format(time.RFC3339),
		Version:    resolvedVersion(),
	}

	// Export memories.
	memories, err := st.QueryDocsBySourceType(ctx, store.SourceMemory, store.OrderByCrawledAtDesc)
	if err != nil {
		return fmt.Errorf("query memories: %w", err)
	}
	for _, d := range memories {
		data.Memories = append(data.Memories, exportDoc{
			URL:         d.URL,
			SectionPath: d.SectionPath,
			Content:     d.Content,
			SourceType:  d.SourceType,
			CrawledAt:   d.CrawledAt,
		})
	}

	// Export specs (if --all flag).
	for _, arg := range os.Args[2:] {
		if arg == "--all" {
			specs, err := st.QueryDocsBySourceType(ctx, store.SourceSpec, store.OrderByURL)
			if err != nil {
				return fmt.Errorf("query specs: %w", err)
			}
			for _, d := range specs {
				data.Specs = append(data.Specs, exportDoc{
					URL:         d.URL,
					SectionPath: d.SectionPath,
					Content:     d.Content,
					SourceType:  d.SourceType,
					CrawledAt:   d.CrawledAt,
				})
			}
			break
		}
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(data); err != nil {
		return fmt.Errorf("encode: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Exported %d memories", len(data.Memories))
	if len(data.Specs) > 0 {
		fmt.Fprintf(os.Stderr, ", %d specs", len(data.Specs))
	}
	fmt.Fprintln(os.Stderr)
	return nil
}
