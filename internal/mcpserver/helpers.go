package mcpserver

import (
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// KBSnippet is a compact knowledge base search result.
type KBSnippet struct {
	SectionPath string `json:"section_path"`
	Content     string `json:"content"`
	URL         string `json:"url"`
}

// Suggestion is a structured improvement suggestion with optional KB context.
type Suggestion struct {
	Severity     string     `json:"severity"`                 // "info", "warning"
	Category     string     `json:"category"`                 // "claude_md", "skills", "rules", "hooks", "mcp"
	Message      string     `json:"message"`
	Affected     []string   `json:"affected,omitempty"`
	BestPractice *KBSnippet `json:"best_practice,omitempty"`
}

// queryKB performs a FTS5 search against the knowledge base and returns
// compact snippets. Designed for internal use by review/suggest — cheap
// FTS5 queries with no Voyage API calls.
// Returns nil when st is nil or query matches nothing.
func queryKB(st *store.Store, query string, limit int) []KBSnippet {
	if st == nil {
		return nil
	}
	if limit <= 0 {
		limit = 3
	}
	docs, err := st.SearchDocsFTS(query, "docs", limit)
	if err != nil || len(docs) == 0 {
		return nil
	}
	snippets := make([]KBSnippet, len(docs))
	for i, d := range docs {
		snippets[i] = KBSnippet{
			SectionPath: d.SectionPath,
			Content:     truncate(d.Content, 300),
			URL:         d.URL,
		}
	}
	return snippets
}

// truncate shortens a string to maxLen runes, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}

// marshalResult encodes v as JSON and wraps it in an MCP CallToolResult.
func marshalResult(v any) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal result: %w", err)
	}
	return mcp.NewToolResultText(string(data)), nil
}
