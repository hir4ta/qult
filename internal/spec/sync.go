package spec

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// SyncResult summarizes a DB sync operation.
type SyncResult struct {
	Upserted  int `json:"upserted"`
	Embedded  int `json:"embedded"`
	Unchanged int `json:"unchanged"`
}

// SyncToDB syncs all spec files to the records table with embeddings.
func SyncToDB(ctx context.Context, sd *SpecDir, st *store.Store, emb *embedder.Embedder) (*SyncResult, error) {
	sections, err := sd.AllSections()
	if err != nil {
		return nil, fmt.Errorf("read sections: %w", err)
	}

	result := &SyncResult{}
	for _, sec := range sections {
		id, changed, err := st.UpsertDoc(ctx, &store.DocRow{
			URL:         sec.URL,
			SectionPath: fmt.Sprintf("%s > %s", sd.TaskSlug, sec.File),
			Content:     sec.Content,
			SourceType:  store.SourceSpec,
			TTLDays:     365,
		})
		if err != nil {
			return nil, fmt.Errorf("upsert %s: %w", sec.File, err)
		}
		if !changed {
			result.Unchanged++
			continue
		}
		result.Upserted++

		if emb != nil && sec.Content != "" {
			vec, err := emb.EmbedForStorage(ctx, sec.Content)
			if err != nil {
				return nil, fmt.Errorf("embed %s: %w", sec.File, err)
			}
			if err := st.InsertEmbedding("records", id, emb.Model(), vec); err != nil {
				return nil, fmt.Errorf("store embedding %s: %w", sec.File, err)
			}
			result.Embedded++
		}
	}
	return result, nil
}

// SyncSingleFile syncs a single spec file to DB.
func SyncSingleFile(ctx context.Context, sd *SpecDir, f SpecFile, st *store.Store, emb *embedder.Embedder) error {
	content, err := sd.ReadFile(f)
	if err != nil {
		return fmt.Errorf("read %s: %w", f, err)
	}

	url := fmt.Sprintf("spec://%s/%s/%s", filepath.Base(sd.ProjectPath), sd.TaskSlug, f)
	id, changed, err := st.UpsertDoc(ctx, &store.DocRow{
		URL:         url,
		SectionPath: fmt.Sprintf("%s > %s", sd.TaskSlug, f),
		Content:     content,
		SourceType:  store.SourceSpec,
		TTLDays:     365,
	})
	if err != nil {
		return fmt.Errorf("upsert: %w", err)
	}

	if changed && emb != nil && content != "" {
		vec, err := emb.EmbedForStorage(ctx, content)
		if err != nil {
			return fmt.Errorf("embed: %w", err)
		}
		if err := st.InsertEmbedding("records", id, emb.Model(), vec); err != nil {
			return fmt.Errorf("store embedding: %w", err)
		}
	}
	return nil
}
