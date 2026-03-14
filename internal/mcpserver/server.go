// Package mcpserver implements the MCP tool server for alfred,
// providing 2 tools: spec management and memory recall.
package mcpserver

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

const serverInstructions = `alfred is your silent butler for Claude Code.

When to use alfred tools:
- Starting a new development task → call spec with action=init
- Making design decisions → call spec with action=update
- Starting/resuming a session → call spec with action=status
- Searching past experiences or saving notes → call recall
`

// New creates a new MCP server with all tools registered.
// ver is the application version (from build-time ldflags or runtime detection).
func New(st *store.Store, emb *embedder.Embedder, ver string) *server.MCPServer {
	s := server.NewMCPServer(
		"alfred",
		ver,
		server.WithToolCapabilities(true),
		server.WithInstructions(serverInstructions),
		server.WithLogging(),
	)

	s.AddTools(
		server.ServerTool{
			Tool: mcp.NewTool("spec",
				mcp.WithDescription(`Unified spec management for development tasks. Persists context across compaction and sessions.

Actions: status (read-only), init, update, switch, delete (2-phase: preview then confirm=true), history, rollback.

task_slug format: lowercase alphanumeric with hyphens (e.g. "my-feature", max 64 chars).
"status"/"history" are read-only. "init"/"update"/"switch"/"delete"/"rollback" modify state.`),
				mcp.WithTitleAnnotation("Spec Management"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(false),
				mcp.WithDestructiveHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("action", mcp.Description("Action to perform"), mcp.Required(), mcp.Enum("init", "update", "status", "switch", "delete", "history", "rollback")),
				mcp.WithString("project_path", mcp.Description("Project root path (defaults to current working directory if omitted)")),
				mcp.WithString("task_slug", mcp.Description("Task identifier (required for init, switch, delete; optional for update/history/rollback — defaults to active task)")),
				mcp.WithString("description", mcp.Description("Brief task description (for init)")),
				mcp.WithString("file", mcp.Description("Spec file (for update/history/rollback)"), mcp.Enum("requirements.md", "design.md", "decisions.md", "session.md")),
				mcp.WithString("content", mcp.Description("Content to write (for update)")),
				mcp.WithString("mode", mcp.Description("Write mode (for update)"), mcp.Enum("append", "replace")),
				mcp.WithString("version", mcp.Description("Version timestamp for rollback (use history to list available versions)")),
				mcp.WithBoolean("confirm", mcp.Description("Required for delete: first call without confirm to preview, then with confirm=true to execute")),
			),
			Handler: specHandler(st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("recall",
				mcp.WithDescription(`Memory search and save — your persistent memory across sessions and projects.

Actions:
- search (default): Search past memories — decisions, session summaries, saved notes
- save: Save a new memory entry for future retrieval

Memories persist permanently and are searchable across ALL projects (cross-project learning).

Use for:
- "Have I worked on something like this before?"
- "What decisions did I make about authentication?"
- "Remember this approach for future reference"

Do NOT use for: searching documentation (use WebFetch instead), file operations.`),
				mcp.WithTitleAnnotation("Memory Recall"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(false),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("action", mcp.Description("Action: search or save"), mcp.Required(), mcp.Enum("search", "save")),
				mcp.WithString("query", mcp.Description("Search query (for search)")),
				mcp.WithString("content", mcp.Description("Content to save (required for save)")),
				mcp.WithString("label", mcp.Description("Short label/description for saved memory (required for save)")),
				mcp.WithString("project", mcp.Description("Project name for context (default: 'general')")),
				mcp.WithNumber("limit", mcp.Description("Maximum search results (default: 10)")),
			),
			Handler: recallHandler(st, emb),
		},
	)

	return s
}
