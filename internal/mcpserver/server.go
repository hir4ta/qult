// Package mcpserver implements the MCP tool server for alfred,
// providing 9 tools: knowledge search, config review/suggest,
// spec management (init/update/status/switch/delete), and code review.
package mcpserver

import (
	"os"
	"path/filepath"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

const serverInstructions = `alfred is your proactive butler for Claude Code.

He works silently in the background, and provides powerful tools when needed:

  knowledge      — Search Claude Code docs and best practices
  config-review  — Deep audit of .claude/ config against best practices
  config-suggest — Analyze git diff, suggest .claude/ config updates
  spec-init      — Initialize spec for a new development task
  spec-update    — Record decisions to active spec (auto DB sync)
  spec-status    — Get current task state for context restoration
  spec-switch    — Switch the primary active task
  spec-delete    — Delete a completed or abandoned task spec
  code-review    — 3-layer knowledge-powered code review

When to use alfred tools:
- Reviewing or auditing .claude/ configuration → call config-review first
- Creating or modifying .claude/ configuration files → call knowledge for best practices first
- Looking up how a Claude Code feature works → call knowledge
- After code changes, check if .claude/ config needs updating → call config-suggest
- Starting a new development task → call spec-init to create spec
- Making design decisions → call spec-update to record
- Starting/resuming a session → call spec-status to check active task
- Reviewing code changes against spec and best practices → call code-review

Do NOT review or create .claude/ configuration by only reading files.
config-review and config-suggest cross-reference your config against best practices from the knowledge base.
Always: alfred tools first → then read/edit files.
`

// defaultClaudeHome returns the default Claude Code configuration directory.
func defaultClaudeHome() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// New creates a new MCP server with all tools registered.
func New(st *store.Store, emb *embedder.Embedder) *server.MCPServer {
	s := server.NewMCPServer(
		"alfred",
		"1.0.0",
		server.WithToolCapabilities(true),
		server.WithInstructions(serverInstructions),
		server.WithLogging(),
	)

	s.AddTools(
		server.ServerTool{
			Tool: mcp.NewTool("knowledge",
				mcp.WithDescription("Search Claude Code documentation and best practices. Uses hybrid vector + FTS5 search with Voyage AI reranking."),
				mcp.WithTitleAnnotation("Knowledge Search"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("query", mcp.Description("Search query"), mcp.Required()),
				mcp.WithNumber("limit", mcp.Description("Maximum results (default: 5)")),
				mcp.WithString("source_type", mcp.Description("Filter by source type: docs, spec, or empty for all")),
			),
			Handler: docsSearchHandler(st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("config-review",
				mcp.WithDescription("Deep audit of .claude/ configuration against best practices. Reads file contents, checks skill sizes and structure, validates rules, and cross-references findings with the knowledge base. Returns structured suggestions with severity levels and documentation references."),
				mcp.WithTitleAnnotation("Config Review"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("project_path", mcp.Description("Project root path (cwd)")),
			),
			Handler: reviewHandler(defaultClaudeHome(), st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("config-suggest",
				mcp.WithDescription("Analyze recent code changes and suggest specific .claude/ configuration updates. Reads git diff content to detect change patterns (new APIs, dependencies, tests, migrations), cross-references with current config and best practices from the knowledge base."),
				mcp.WithTitleAnnotation("Config Suggestions"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("project_path", mcp.Description("Project root path (cwd)")),
			),
			Handler: suggestHandler(defaultClaudeHome(), st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("spec-init",
				mcp.WithDescription("Initialize a new spec for a development task. Creates .alfred/specs/{task_slug}/ with template files (requirements, design, decisions, session) and syncs to the knowledge DB for semantic search."),
				mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
				mcp.WithString("task_slug", mcp.Description("URL-safe task identifier (e.g., 'add-auth', 'fix-memory-leak')"), mcp.Required()),
				mcp.WithString("description", mcp.Description("Brief description of the task goal")),
			),
			Handler: butlerInitHandler(st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("spec-update",
				mcp.WithDescription("Update a spec file for the active task. Appends or replaces content, then syncs to the knowledge DB. Use for recording decisions and session state."),
				mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
				mcp.WithString("file", mcp.Description("Spec file to update: requirements.md, design.md, decisions.md, session.md"), mcp.Required()),
				mcp.WithString("content", mcp.Description("Content to write"), mcp.Required()),
				mcp.WithString("mode", mcp.Description("Write mode: 'append' (default) or 'replace'")),
			),
			Handler: butlerUpdateHandler(st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("spec-status",
				mcp.WithDescription("Get the current spec status for a project. Returns the active task's session state, requirements, and decisions. Use at session start to restore context after compact or new session."),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
			),
			Handler: butlerStatusHandler(),
		},

		server.ServerTool{
			Tool: mcp.NewTool("spec-switch",
				mcp.WithDescription("Switch the primary active task. Use when working on multiple tasks and you want to change which spec is active for spec-update and session hooks."),
				mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
				mcp.WithString("task_slug", mcp.Description("Task slug to switch to (must already exist)"), mcp.Required()),
			),
			Handler: butlerSwitchHandler(),
		},

		server.ServerTool{
			Tool: mcp.NewTool("spec-delete",
				mcp.WithDescription("Delete a task's spec directory and remove it from the knowledge DB. Use to clean up completed or abandoned tasks."),
				mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
				mcp.WithString("task_slug", mcp.Description("Task slug to delete"), mcp.Required()),
			),
			Handler: butlerDeleteHandler(st),
		},

		server.ServerTool{
			Tool: mcp.NewTool("code-review",
				mcp.WithDescription("3-layer knowledge-powered code review. Layer 1: checks changes against active spec (decisions, requirements scope). Layer 2: semantic search for related knowledge. Layer 3: best practices from documentation sources."),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("project_path", mcp.Description("Absolute path to the project root"), mcp.Required()),
				mcp.WithString("focus", mcp.Description("Optional focus area for the review (e.g., 'auth logic', 'error handling')")),
			),
			Handler: butlerReviewHandler(st, emb),
		},
	)

	return s
}
