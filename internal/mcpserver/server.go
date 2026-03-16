// Package mcpserver implements the MCP tool server for alfred,
// providing 2 tools: dossier (spec management) and ledger (memory).
package mcpserver

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

const serverInstructions = `alfred is your development butler for Claude Code.

When to use alfred tools:
- Starting a new development task → call dossier with action=init
- Making design decisions → call dossier with action=update
- Starting/resuming a session → call dossier with action=status
- Searching past experiences or saving notes → call ledger
- Grouping related tasks into an epic → call roster with action=init, then link tasks
- Checking epic progress → call roster with action=status
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
			Tool: mcp.NewTool("dossier",
				mcp.WithDescription(`Unified spec management for development tasks. Persists context across compaction and sessions.

Actions: status (read-only), init, update, switch, complete, delete (2-phase: preview then confirm=true), history, rollback, review.

task_slug format: lowercase alphanumeric with hyphens (e.g. "my-feature", max 64 chars).
"status"/"history"/"review" are read-only. "init"/"update"/"switch"/"complete"/"delete"/"rollback" modify state.
Lifecycle: active → complete (preserves files) or delete (removes files).
Review: TUI dashboard で承認/コメント → dossier action=review で確認.`),
				mcp.WithTitleAnnotation("Dossier — Spec Management"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(false),
				mcp.WithDestructiveHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("action", mcp.Description("Action to perform"), mcp.Required(), mcp.Enum("init", "update", "status", "switch", "complete", "delete", "history", "rollback", "review")),
				mcp.WithString("project_path", mcp.Description("Project root path (defaults to current working directory if omitted)")),
				mcp.WithString("task_slug", mcp.Description("Task identifier (required for init, switch, delete; optional for update/history/rollback — defaults to active task)")),
				mcp.WithString("description", mcp.Description("Brief task description (for init)")),
				mcp.WithString("file", mcp.Description("Spec file (for update/history/rollback)"), mcp.Enum("requirements.md", "design.md", "tasks.md", "test-specs.md", "decisions.md", "research.md", "session.md")),
				mcp.WithString("content", mcp.Description("Content to write (for update)")),
				mcp.WithString("mode", mcp.Description("Write mode (for update)"), mcp.Enum("append", "replace")),
				mcp.WithString("version", mcp.Description("Version timestamp for rollback (use history to list available versions)")),
				mcp.WithBoolean("confirm", mcp.Description("Required for delete: first call without confirm to preview, then with confirm=true to execute")),
			),
			Handler: specHandler(st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("roster",
				mcp.WithDescription(`Epic management — group related tasks with dependencies and progress tracking.

Actions: init, status, link, unlink, order, list, update, delete (2-phase: preview then confirm=true).

Epics bundle multiple specs (tasks) into a cohesive goal with dependency ordering.
Tasks (specs) are NOT deleted when an epic is removed — they become standalone.`),
				mcp.WithTitleAnnotation("Roster — Epic Management"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithDestructiveHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("action", mcp.Description("Action to perform"), mcp.Required(), mcp.Enum("init", "status", "link", "unlink", "order", "list", "update", "delete")),
				mcp.WithString("project_path", mcp.Description("Project root path (defaults to cwd)")),
				mcp.WithString("epic_slug", mcp.Description("Epic identifier (required for most actions)")),
				mcp.WithString("task_slug", mcp.Description("Task to link/unlink (for link/unlink)")),
				mcp.WithString("name", mcp.Description("Epic display name (for init/update)")),
				mcp.WithString("depends_on", mcp.Description("Comma-separated task slugs this task depends on (for link)")),
				mcp.WithString("status", mcp.Description("Epic status: draft, in-progress, completed, archived (for update)")),
				mcp.WithBoolean("confirm", mcp.Description("Required for delete: preview first, then confirm=true")),
			),
			Handler: epicHandler(),
		},

		server.ServerTool{
			Tool: mcp.NewTool("ledger",
				mcp.WithDescription(`Long-term knowledge search, save, and health management — memories and past specs, searchable across sessions and projects.

Actions:
- search (default): Search past memories AND completed specs
- save: Save a new memory entry for future retrieval
- promote: Promote a memory's sub_type (general→pattern or pattern→rule) — requires id and sub_type
- candidates: List memories that qualify for sub_type promotion based on hit_count
- reflect: Read-only health report — stats, conflicts, stale memories, promotion candidates

Knowledge persists permanently and grows with use. Memories track hit_count (how often they appear in search results) and can be promoted from general→pattern→rule as they prove their value.

Use for:
- "Have I worked on something like this before?" (search)
- "Remember this approach for future reference" (save)
- "What memories should be promoted?" (candidates)
- "How healthy is my knowledge base?" (reflect)
- "Promote this memory to a rule" (promote)

Do NOT use for: searching documentation (use WebFetch instead), file operations.`),
				mcp.WithTitleAnnotation("Ledger — Memory"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(false),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("action", mcp.Description("Action: search, save, promote, candidates, or reflect"), mcp.Required(), mcp.Enum("search", "save", "promote", "candidates", "reflect")),
				mcp.WithNumber("id", mcp.Description("Record ID (required for promote)")),
				mcp.WithString("query", mcp.Description("Search query (for search)")),
				mcp.WithString("content", mcp.Description("Content to save (required for save)")),
				mcp.WithString("label", mcp.Description("Short label/description for saved memory (required for save)")),
				mcp.WithString("project", mcp.Description("Project name for context (default: 'general')")),
				mcp.WithNumber("limit", mcp.Description("Maximum search results (default: 10)")),
				mcp.WithString("detail", mcp.Description("Response verbosity: compact (labels only), summary (200-char snippets, default), full (complete content)"), mcp.Enum("compact", "summary", "full")),
				mcp.WithString("sub_type", mcp.Description("Memory classification for save, or filter for search: decision (design choices), pattern (reusable practices), rule (enforced standards), general (default)"), mcp.Enum("general", "decision", "pattern", "rule")),
			mcp.WithString("title", mcp.Description("Structured knowledge: title for decision/pattern/rule (optional, defaults to label)")),
			mcp.WithString("context_text", mcp.Description("Structured knowledge: context/background information (optional)")),
			mcp.WithString("reasoning", mcp.Description("Structured knowledge: reasoning or rationale (optional)")),
			mcp.WithString("alternatives", mcp.Description("Structured knowledge: comma-separated rejected alternatives (optional, for decisions)")),
			mcp.WithString("category", mcp.Description("Structured knowledge: rule category (optional, for rules)")),
			mcp.WithString("priority", mcp.Description("Structured knowledge: rule priority p0/p1/p2 (optional, for rules)")),
			mcp.WithString("project_path", mcp.Description("Project root path for structured knowledge JSON file storage (defaults to cwd)")),
			),
			Handler: recallHandler(st, emb),
		},
	)

	return s
}
