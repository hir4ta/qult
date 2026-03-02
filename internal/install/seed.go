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

// SeedProgress provides callbacks for the two phases of seeding.
type SeedProgress struct {
	OnDocUpsert  func(done, total int) // Phase 1: doc upsert progress
	OnEmbedBatch func(done, total int) // Phase 2: embedding progress
}

const embedBatchSize = 50

// ApplySeed loads the embedded seed data into the store's docs table and generates embeddings.
// Two-phase approach: Phase 1 upserts all docs, Phase 2 batch-embeds via Voyage API.
func ApplySeed(ctx context.Context, st *store.Store, emb *embedder.Embedder, progress *SeedProgress) (SeedResult, error) {
	if emb == nil {
		return SeedResult{}, fmt.Errorf("seed: embedder is required")
	}

	sf, err := LoadEmbedded()
	if err != nil {
		return SeedResult{}, err
	}

	if len(sf.Sources) == 0 {
		return SeedResult{}, nil // empty seed (dev build)
	}

	// Count total sections.
	total := 0
	for _, src := range sf.Sources {
		total += len(src.Sections)
	}

	var res SeedResult

	// Phase 1: Upsert all docs, collect pending embeddings.
	type pendingEmbed struct {
		docID     int64
		embedText string
	}
	var pending []pendingEmbed
	done := 0

	for _, src := range sf.Sources {
		for _, sec := range src.Sections {
			doc := &store.DocRow{
				URL:         src.URL,
				SectionPath: sec.Path,
				Content:     sec.Content,
				SourceType:  src.SourceType,
				Version:     src.Version,
				CrawledAt:   sf.CrawledAt,
				TTLDays:     365,
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

			// Collect docs that need embedding.
			if _, err := st.GetEmbedding("docs", docID); err != nil {
				pending = append(pending, pendingEmbed{
					docID:     docID,
					embedText: sec.Path + "\n" + sec.Content,
				})
			}

			done++
			if progress != nil && progress.OnDocUpsert != nil {
				progress.OnDocUpsert(done, total)
			}
		}
	}

	// Phase 2: Batch embed.
	for i := 0; i < len(pending); i += embedBatchSize {
		if err := ctx.Err(); err != nil {
			return res, err
		}

		end := min(i+embedBatchSize, len(pending))
		batch := pending[i:end]

		texts := make([]string, len(batch))
		for j, p := range batch {
			texts[j] = p.embedText
		}

		vecs, err := emb.EmbedBatchForStorage(ctx, texts)
		if err != nil {
			return res, fmt.Errorf("seed: embed batch %d-%d: %w", i, end, err)
		}

		for j, vec := range vecs {
			if err := st.InsertEmbedding("docs", batch[j].docID, emb.Model(), vec); err != nil {
				return res, fmt.Errorf("seed: store embedding %d: %w", batch[j].docID, err)
			}
			res.Embedded++
		}

		if progress != nil && progress.OnEmbedBatch != nil {
			progress.OnEmbedBatch(min(i+len(batch), len(pending)), len(pending))
		}
	}

	return res, nil
}
