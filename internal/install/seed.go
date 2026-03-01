package install

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

//go:embed seed_docs.json
var seedJSON []byte

// SeedFile is the top-level structure for pre-crawled documentation seed data.
type SeedFile struct {
	CrawledAt string       `json:"crawled_at"`
	Sources   []SeedSource `json:"sources"`
}

// SeedSource represents one documentation page or blog post.
type SeedSource struct {
	URL        string        `json:"url"`
	SourceType string        `json:"source_type"` // "docs", "changelog", "engineering"
	Version    string        `json:"version,omitempty"`
	Sections   []SeedSection `json:"sections"`
}

// SeedSection represents a single heading-delimited section within a page.
type SeedSection struct {
	Path    string `json:"path"`    // e.g. "Hooks > PreToolUse"
	Content string `json:"content"` // section text
}

// LoadEmbedded parses the built-in seed data from the embedded JSON.
func LoadEmbedded() (*SeedFile, error) {
	var sf SeedFile
	if err := json.Unmarshal(seedJSON, &sf); err != nil {
		return nil, fmt.Errorf("seed: parse embedded data: %w", err)
	}
	return &sf, nil
}

// SeedResult holds counts from ApplySeed for reporting.
type SeedResult struct {
	Applied   int
	Unchanged int
	Embedded  int
}

// ApplySeed loads the embedded seed data into the store's docs table.
// Uses UpsertDoc for content-hash deduplication — safe to call on every install.
// The embedder may be nil; in that case only FTS5 indexing occurs.
func ApplySeed(st *store.Store, emb *embedder.Embedder, progress func(done, total int)) (SeedResult, error) {
	sf, err := LoadEmbedded()
	if err != nil {
		return SeedResult{}, err
	}

	if len(sf.Sources) == 0 {
		return SeedResult{}, nil // empty seed (dev build)
	}

	// Count total sections for progress.
	total := 0
	for _, src := range sf.Sources {
		total += len(src.Sections)
	}

	var res SeedResult
	done := 0
	ctx := context.Background()

	embAvailable := emb != nil && emb.Available()

	for _, src := range sf.Sources {
		for _, sec := range src.Sections {
			doc := &store.DocRow{
				URL:         src.URL,
				SectionPath: sec.Path,
				Content:     sec.Content,
				SourceType:  src.SourceType,
				Version:     src.Version,
				CrawledAt:   sf.CrawledAt,
				TTLDays:     365, // bundled seed data persists for a year
			}

			docID, changed, err := st.UpsertDoc(doc)
			if err != nil {
				return res, fmt.Errorf("seed: upsert %q: %w", sec.Path, err)
			}

			if !changed {
				res.Unchanged++
			} else {
				res.Applied++
			}

			// Generate embedding if missing (handles both new docs and
			// dimension upgrades where old embeddings were cleared).
			if embAvailable {
				if _, err := st.GetEmbedding("docs", docID); err != nil {
					embedText := sec.Path + "\n" + sec.Content
					vec, err := emb.EmbedForStorage(ctx, embedText)
					if err == nil {
						if st.InsertEmbedding("docs", docID, emb.Model(), vec) == nil {
							res.Embedded++
						}
					}
				}
			}

			done++
			if progress != nil {
				progress(done, total)
			}
		}
	}

	return res, nil
}
