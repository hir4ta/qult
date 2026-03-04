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

He never interrupts your work. When you need him, he's ready:

  knowledge   — Search Claude Code docs and best practices
  review      — Deep audit of .claude/ config: reads file contents, checks sizes, cross-references with best practices
  suggest     — Reads git diff content, detects change patterns, suggests specific config updates with best practices

When to use alfred tools:
- Reviewing or auditing .claude/ configuration → call review first (reads file contents, checks skill sizes and structure, validates rules, cross-references with knowledge base)
- Creating or modifying .claude/ configuration files → call knowledge for best practices first
- Looking up how a Claude Code feature works → call knowledge
- After code changes, check if .claude/ config needs updating → call suggest (reads diff content, detects patterns like new APIs/deps/tests)

Do NOT review or create .claude/ configuration by only reading files.
review and suggest cross-reference your config against best practices from the knowledge base — information not in your training data.
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

	ar := newAutoRefresher(st, emb)

	s.AddTools(
		server.ServerTool{
			Tool: mcp.NewTool("knowledge",
				mcp.WithDescription("Search Claude Code documentation and best practices. Uses hybrid vector + FTS5 search with Voyage AI reranking."),
				mcp.WithTitleAnnotation("Knowledge Search"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("query", mcp.Description("Search query"), mcp.Required()),
				mcp.WithNumber("limit", mcp.Description("Maximum results (default: 5)")),
			),
			Handler: docsSearchHandler(st, emb, ar),
		},

		server.ServerTool{
			Tool: mcp.NewTool("review",
				mcp.WithDescription("Deep audit of .claude/ configuration against best practices. Reads file contents, checks skill sizes and structure, validates rules, and cross-references findings with the knowledge base. Returns structured suggestions with severity levels and documentation references."),
				mcp.WithTitleAnnotation("Project Review"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("project_path", mcp.Description("Project root path (cwd)")),
			),
			Handler: reviewHandler(defaultClaudeHome(), st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("suggest",
				mcp.WithDescription("Analyze recent code changes and suggest specific .claude/ configuration updates. Reads git diff content to detect change patterns (new APIs, dependencies, tests, migrations), cross-references with current config and best practices from the knowledge base."),
				mcp.WithTitleAnnotation("Config Suggestions"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("project_path", mcp.Description("Project root path (cwd)")),
			),
			Handler: suggestHandler(defaultClaudeHome(), st, emb),
		},
	)

	return s
}
