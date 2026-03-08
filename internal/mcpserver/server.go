// Package mcpserver implements the MCP tool server for alfred,
// providing 4 tools: knowledge search, config review,
// spec management, and memory recall.
package mcpserver

import (
	"os"
	"path/filepath"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

const serverInstructions = `alfred is your silent butler for Claude Code.

He works silently in the background, and provides powerful tools when needed:

  knowledge      — Search Claude Code docs and best practices
  config-review  — Deep audit of .claude/ config against best practices
  spec           — Unified spec management (action: init/update/status/switch/delete)
  recall         — Memory search and save (past sessions, decisions, notes)

When to use alfred tools:
- Questions specifically about Claude Code configuration or best practices → call knowledge FIRST
  (hooks, skills, rules, agents, plugins, MCP, CLAUDE.md, memory, permissions, settings, compaction)
- Evaluating or auditing .claude/ configuration → call config-review
- Creating or modifying .claude/ configuration files → call knowledge for best practices, THEN make changes
- Starting a new development task → call spec with action=init
- Making design decisions → call spec with action=update
- Starting/resuming a session → call spec with action=status
- Searching past experiences or saving notes → call recall

IMPORTANT: knowledge contains extensive curated Claude Code docs with hybrid search.
Always prefer knowledge over web search or guessing for Claude Code topics.
config-review cross-references your config against best practices from the knowledge base.
`

// defaultClaudeHome returns the default Claude Code configuration directory.
// Returns empty string if home directory cannot be determined.
func defaultClaudeHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}

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
			Tool: mcp.NewTool("knowledge",
				mcp.WithDescription(`Search Claude Code documentation and best practices. Uses hybrid vector + FTS5 search with Voyage AI reranking.

Use for: hooks, skills, rules, agents, plugins, MCP servers, CLAUDE.md, memory, permissions, settings, compaction, CLI features.
Do NOT use for: general programming questions, project-specific code, non-Claude-Code topics.

Example queries: "SessionStart hook best practices", "skill frontmatter options", "MCP tool annotations", "CLAUDE.md size guidelines".`),
				mcp.WithTitleAnnotation("Knowledge Search"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("query", mcp.Description("Search query"), mcp.Required()),
				mcp.WithNumber("limit", mcp.Description("Maximum results (default: 5)")),
				mcp.WithString("source_type", mcp.Description("Filter by source type: docs, memory, spec, changelog, engineering. Comma-separated for multiple (default: docs,memory)")),
			),
			Handler: docsSearchHandler(st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("config-review",
				mcp.WithDescription(`Deep audit of .claude/ configuration against best practices. Reads file contents, checks skill sizes and structure, validates rules, and cross-references findings with the knowledge base. Returns structured suggestions with severity levels and documentation references.

Checks: CLAUDE.md quality, skills (size/frontmatter), rules (path scoping), hooks (performance/patterns), MCP server config, and settings.json.
Requires project_path to locate .claude/ directory. If omitted, uses current working directory.`),
				mcp.WithTitleAnnotation("Config Review"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("project_path", mcp.Description("Project root path (cwd)")),
			),
			Handler: reviewHandler(defaultClaudeHome(), st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("spec",
				mcp.WithDescription(`Unified spec management for development tasks. Persists context across compaction and sessions.

Actions:
- status: Get active task state — READ-ONLY, safe to call anytime
- init: Create a new spec (requires task_slug, e.g. "auth-refactor")
- update: Write to a spec file (requires file + content, mode: "append" or "replace")
- switch: Change active task (requires task_slug)
- delete: Remove a task spec (requires task_slug; first call previews, add confirm=true to execute) — DESTRUCTIVE

task_slug format: lowercase alphanumeric with hyphens (e.g. "my-feature", max 64 chars).

Note: "status" is read-only. Only "init", "update", "switch", and "delete" modify state.`),
				mcp.WithTitleAnnotation("Spec Management"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithDestructiveHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("action", mcp.Description("Action to perform: init, update, status, switch, delete"), mcp.Required()),
				mcp.WithString("project_path", mcp.Description("Absolute path to the project root")),
				mcp.WithString("task_slug", mcp.Description("Task identifier (required for init, switch, delete)")),
				mcp.WithString("description", mcp.Description("Brief task description (for init)")),
				mcp.WithString("file", mcp.Description("Spec file to update: requirements.md, design.md, decisions.md, session.md (for update)")),
				mcp.WithString("content", mcp.Description("Content to write (for update)")),
				mcp.WithString("mode", mcp.Description("Write mode: 'append' (default) or 'replace' (for update)")),
				mcp.WithBoolean("confirm", mcp.Description("Required for delete: first call without confirm to preview, then with confirm=true to execute")),
			),
			Handler: specHandler(st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("recall",
				mcp.WithDescription(`Memory search and save — your persistent memory across sessions.

Actions:
- search (default): Search past memories — decisions, session summaries, saved notes
- save: Save a new memory entry for future retrieval

Memories persist permanently and are searchable across projects. Use for:
- "Have I worked on something like this before?"
- "What decisions did I make about authentication?"
- "Remember this approach for future reference"`),
				mcp.WithTitleAnnotation("Memory Recall"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("action", mcp.Description("Action: 'search' (default) or 'save'"), mcp.Required()),
				mcp.WithString("query", mcp.Description("Search query (required for search)")),
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
