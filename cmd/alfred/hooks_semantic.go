package main

import (
	"context"
	"fmt"
	"path/filepath"
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
		// No Voyage — try FTS5 fallback.
		return handleFTSFallback(ctx, ev, prompt, rememberHint)
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

	// File context boost: score up memories related to currently changed files.
	if ev.ProjectPath != "" && len(snippets) < 3 {
		fileSnippets := searchByChangedFiles(ctx, st, ev.ProjectPath)
		snippets = append(snippets, fileSnippets...)
		if len(snippets) > 3 {
			snippets = snippets[:3]
		}
	}

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

// handleFTSFallback uses FTS5 search when Voyage is unavailable.
// Returns true if it produced output, false otherwise.
func handleFTSFallback(ctx context.Context, ev *hookEvent, prompt string, rememberHint string) bool {
	st, err := openStore()
	if err != nil {
		return false
	}

	docs, err := st.SearchKnowledgeFTS(ctx, prompt, 3)
	if err != nil || (len(docs) == 0 && rememberHint == "") {
		if rememberHint != "" {
			emitAdditionalContext("UserPromptSubmit", rememberHint)
			return true
		}
		return false
	}

	var buf strings.Builder
	if rememberHint != "" {
		buf.WriteString(rememberHint + "\n\n")
	}
	if len(docs) > 0 {
		buf.WriteString("Related past experience:\n")
		for _, d := range docs {
			snippet := safeSnippet(d.Content, 200)
			buf.WriteString(fmt.Sprintf("- [memory: %s] %s\n", d.Title, snippet))
		}
	}
	if buf.Len() > 0 {
		emitAdditionalContext("UserPromptSubmit", buf.String())
	}
	return true
}

// searchByChangedFiles looks up memories related to currently modified files.
// Returns formatted snippet lines.
func searchByChangedFiles(ctx context.Context, st *store.Store, projectPath string) []string {
	files := getChangedFilesQuick(projectPath)
	if len(files) == 0 {
		return nil
	}

	// Build a search query from changed file names (basenames only).
	var terms []string
	seen := make(map[string]bool)
	for _, f := range files {
		base := filepath.Base(f)
		base = strings.TrimSuffix(base, filepath.Ext(base))
		if base != "" && !seen[base] {
			seen[base] = true
			terms = append(terms, base)
		}
		if len(terms) >= 5 {
			break
		}
	}
	if len(terms) == 0 {
		return nil
	}

	query := strings.Join(terms, " ")
	docs, err := st.SearchKnowledgeFTS(ctx, query, 2)
	if err != nil || len(docs) == 0 {
		return nil
	}

	var results []string
	for _, d := range docs {
		snippet := safeSnippet(d.Content, 200)
		results = append(results, fmt.Sprintf("- [file-context: %s] %s\n", d.Title, snippet))
	}
	return results
}

// getChangedFilesQuick returns changed file paths from git (quick version for hooks).
func getChangedFilesQuick(projectPath string) []string {
	cmd := execCommand("git", "diff", "--name-only", "HEAD")
	cmd.Dir = projectPath
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var files []string
	for _, f := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f = strings.TrimSpace(f)
		if f != "" {
			files = append(files, f)
		}
	}
	return files
}

// searchKnowledgeSemantic searches memories and past specs using vector similarity.
// Returns formatted snippet lines (max 3) or nil.
// Memory and spec results are labeled differently for clarity.
func searchKnowledgeSemantic(ctx context.Context, queryVec []float32, st *store.Store) []string {
	if queryVec == nil {
		return nil
	}

	matches, err := st.VectorSearchKnowledge(ctx, queryVec, 6)
	if err != nil || len(matches) == 0 {
		return nil
	}

	limit := min(3, len(matches))
	ids := make([]int64, limit)
	for i := 0; i < limit; i++ {
		ids[i] = matches[i].SourceID
	}
	docs, err := st.GetKnowledgeByIDs(ctx, ids)
	if err != nil || len(docs) == 0 {
		return nil
	}

	var results []string
	for _, d := range docs {
		snippet := safeSnippet(d.Content, 200)
		label := "memory"
		if d.SubType == "spec" {
			label = "past spec"
		}
		results = append(results, fmt.Sprintf("- [%s: %s] %s\n", label, d.Title, snippet))
	}
	return results
}
