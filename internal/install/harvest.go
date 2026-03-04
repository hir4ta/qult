package install

import (
	"context"
	"fmt"
	"time"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// HarvestSources crawls and embeds the given custom sources in-process (no TUI).
// Intended for background auto-refresh from the MCP server.
func HarvestSources(ctx context.Context, st *store.Store, emb *embedder.Embedder, sources []CustomSource) (SeedResult, error) {
	if len(sources) == 0 {
		return SeedResult{}, nil
	}

	customSources := CrawlCustomSources(sources, nil)
	if len(customSources) == 0 {
		return SeedResult{}, nil
	}

	sf := &SeedFile{
		CrawledAt: time.Now().UTC().Format(time.RFC3339),
		Sources:   customSources,
	}

	return ApplySeedData(ctx, st, emb, sf, nil)
}

// SourceURLMap builds a url→name mapping from custom sources for stale detection.
func SourceURLMap(sources []CustomSource) map[string]string {
	m := make(map[string]string, len(sources))
	for _, s := range sources {
		m[s.URL] = s.Name
	}
	return m
}

// LoadCustomSources parses the default sources.yaml and returns the sources list.
// Returns nil, nil if the file does not exist.
func LoadCustomSources() ([]CustomSource, error) {
	sf, err := ParseSourcesFile(DefaultSourcesPath())
	if err != nil {
		return nil, fmt.Errorf("sources.yaml: %w", err)
	}
	if sf == nil {
		return nil, nil
	}
	return sf.Sources, nil
}
