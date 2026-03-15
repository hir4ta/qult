package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// newEmbedder creates a Voyage embedder, returning nil if unavailable.
// Overridable in tests.
var newEmbedder = func() *embedder.Embedder {
	emb, err := embedder.NewEmbedder()
	if err != nil {
		return nil
	}
	return emb
}

// handleSemanticSearch performs semantic memory search using Voyage embeddings.
// Returns true if it handled the injection (caller should not emit fallback hints).
// Returns false if Voyage is unavailable or search failed.
func handleSemanticSearch(ctx context.Context, ev *hookEvent, prompt string, rememberHint string) bool {
	emb := newEmbedder()
	if emb == nil {
		return false
	}

	st, err := openStore()
	if err != nil {
		return false
	}
	st.ExpectedDims = emb.Dims()

	queryVec, err := emb.EmbedForSearch(ctx, prompt)
	if err != nil {
		return false
	}

	// Search memories and past specs — long-term knowledge that grows with use.
	snippets := searchKnowledgeSemantic(ctx, queryVec, st)
	if len(snippets) == 0 && rememberHint == "" {
		return true // semantic search ran, just no results
	}

	var buf strings.Builder
	if rememberHint != "" {
		buf.WriteString(rememberHint + "\n\n")
	}
	if len(snippets) > 0 {
		buf.WriteString("Related past experience:\n")
		for _, m := range snippets {
			buf.WriteString(m)
		}
	}
	if buf.Len() > 0 {
		emitAdditionalContext("UserPromptSubmit", buf.String())
	}
	return true
}

// searchKnowledgeSemantic searches memories and past specs using vector similarity.
// Returns formatted snippet lines (max 3) or nil.
// Memory and spec results are labeled differently for clarity.
func searchKnowledgeSemantic(ctx context.Context, queryVec []float32, st *store.Store) []string {
	if queryVec == nil {
		return nil
	}

	matches, err := st.VectorSearch(ctx, queryVec, "records", 6, store.SourceMemory, store.SourceSpec)
	if err != nil || len(matches) == 0 {
		return nil
	}

	limit := min(3, len(matches))
	ids := make([]int64, limit)
	for i := 0; i < limit; i++ {
		ids[i] = matches[i].SourceID
	}
	docs, err := st.GetDocsByIDs(ctx, ids)
	if err != nil || len(docs) == 0 {
		return nil
	}

	var results []string
	for _, d := range docs {
		snippet := safeSnippet(d.Content, 200)
		label := "memory"
		if d.SourceType == store.SourceSpec {
			label = "past spec"
		}
		results = append(results, fmt.Sprintf("- [%s: %s] %s\n", label, d.SectionPath, snippet))
	}
	return results
}
