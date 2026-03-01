package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// IngestSection is a single section to ingest.
type IngestSection struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// IngestResponse is the typed response for the ingest MCP tool.
type IngestResponse struct {
	URL         string `json:"url"`
	SourceType  string `json:"source_type"`
	Ingested    int    `json:"ingested"`
	Unchanged   int    `json:"unchanged"`
	Embedded    int    `json:"embedded"`
	EmbedErrors int    `json:"embed_errors,omitempty"`
}

func ingestHandler(st *store.Store, emb *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if st == nil {
			return mcp.NewToolResultError("store not available"), nil
		}

		url := req.GetString("url", "")
		if url == "" {
			return mcp.NewToolResultError("url is required"), nil
		}

		sourceType := req.GetString("source_type", "docs")
		version := req.GetString("version", "")
		ttlDays := req.GetInt("ttl_days", 7)
		if ttlDays < 1 {
			ttlDays = 7
		}

		// Parse sections array from arguments.
		// Handles both native JSON array and string-encoded JSON.
		args := req.GetArguments()
		sectionsRaw, ok := args["sections"]
		if !ok {
			return mcp.NewToolResultError("sections is required"), nil
		}

		var sectionsJSON []byte
		if s, ok := sectionsRaw.(string); ok {
			// String-encoded JSON (e.g. from some MCP clients).
			sectionsJSON = []byte(s)
		} else {
			var err error
			sectionsJSON, err = json.Marshal(sectionsRaw)
			if err != nil {
				return mcp.NewToolResultError("invalid sections: " + err.Error()), nil
			}
		}

		var sections []IngestSection
		if err := json.Unmarshal(sectionsJSON, &sections); err != nil {
			return mcp.NewToolResultError("sections must be an array of {path, content}: " + err.Error()), nil
		}
		if len(sections) == 0 {
			return mcp.NewToolResultError("sections array is empty"), nil
		}

		resp := IngestResponse{
			URL:        url,
			SourceType: sourceType,
		}

		for _, sec := range sections {
			if sec.Path == "" || sec.Content == "" {
				continue
			}

			doc := &store.DocRow{
				URL:         url,
				SectionPath: sec.Path,
				Content:     sec.Content,
				ContentHash: store.ContentHashOf(sec.Content),
				SourceType:  sourceType,
				Version:     version,
				TTLDays:     ttlDays,
			}

			docID, changed, err := st.UpsertDoc(doc)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("failed to upsert doc %q: %v", sec.Path, err)), nil
			}

			if !changed {
				resp.Unchanged++
				continue
			}
			resp.Ingested++

			// Generate embedding for the new/updated doc.
			embedText := sec.Path + "\n" + sec.Content
			vec, err := emb.EmbedForStorage(ctx, embedText)
			if err != nil {
				resp.EmbedErrors++
				continue
			}
			if err := st.InsertEmbedding("docs", docID, emb.Model(), vec); err != nil {
				resp.EmbedErrors++
			} else {
				resp.Embedded++
			}
		}

		return marshalResult(resp)
	}
}
