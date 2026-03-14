package main

import (
	"context"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// openStore is the function used to obtain a store connection.
// Overridable in tests.
var openStore = func() (*store.Store, error) {
	return store.OpenDefaultCached()
}

// ---------------------------------------------------------------------------
// UserPromptSubmit: semantic search + remember intent
// ---------------------------------------------------------------------------

// handleUserPromptSubmit performs semantic knowledge injection and detects
// "remember this" intent for the recall tool.
//
// When VOYAGE_API_KEY is set: semantic search (embed + vector similarity)
// When unavailable: only remember hints are emitted.
func handleUserPromptSubmit(ctx context.Context, ev *hookEvent) {
	prompt := strings.TrimSpace(ev.Prompt)
	if len([]rune(prompt)) < 10 {
		return
	}

	// Detect "remember this" intent.
	rememberHint := ""
	if detectRememberIntent(prompt) {
		rememberHint = "User wants to save information. Use the recall tool with action=save to persist this as permanent memory. " +
			"Parameters: content (what to save), label (short description), project (optional context)."
	}

	// Semantic search for memories.
	if handleSemanticSearch(ctx, ev, prompt, rememberHint) {
		return
	}

	// Voyage unavailable — emit non-search hints only.
	if rememberHint != "" {
		emitAdditionalContext("UserPromptSubmit", rememberHint)
	}
}

// rememberKeywords are phrases indicating the user wants to save information.
var rememberKeywords = []string{
	"覚えて", "覚えておいて", "記憶して", "記憶しておいて",
	"メモして", "メモしておいて",
	"remember this", "remember that", "save this", "save that",
	"don't forget",
}

// detectRememberIntent returns true if the prompt contains a "remember this" keyword.
func detectRememberIntent(prompt string) bool {
	lower := strings.ToLower(prompt)
	for _, kw := range rememberKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}
