package spec

import (
	"context"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// SyncResult summarizes a DB sync operation.
type SyncResult struct {
	Upserted  int `json:"upserted"`
	Embedded  int `json:"embedded"`
	Unchanged int `json:"unchanged"`
}

// SyncToDB is a no-op in the new architecture.
// Spec files live on the filesystem; DB stores only knowledge entries.
func SyncToDB(_ context.Context, _ *SpecDir, _ *store.Store, _ *embedder.Embedder) (*SyncResult, error) {
	return &SyncResult{}, nil
}

// SyncSingleFile is a no-op in the new architecture.
func SyncSingleFile(_ context.Context, _ *SpecDir, _ SpecFile, _ *store.Store, _ *embedder.Embedder) error {
	return nil
}
