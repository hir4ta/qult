package mcpserver

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

const serverInstructions = `alfred is your silent butler for Claude Code.

He never interrupts your work. When you need him, he's ready:

  knowledge   — Search Claude Code docs and best practices
  recall      — Recall project context from past sessions
  review      — Analyze your project's Claude Code utilization
  ingest      — Store documentation with vector embeddings

When to use alfred tools:
- Claude Code の設定（rules, skills, hooks, MCP, CLAUDE.md）をレビュー・改善するとき → review を先に実行
- Claude Code の機能やベストプラクティスを調べるとき → knowledge で検索
- ファイルの過去の変更理由や作業履歴を調べるとき → recall で検索
`

// New creates a new MCP server with all tools registered.
func New(claudeHome string, st *store.Store, emb *embedder.Embedder) *server.MCPServer {
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
			),
			Handler: docsSearchHandler(st, emb),
		},

		server.ServerTool{
			Tool: mcp.NewTool("recall",
				mcp.WithDescription("Recall project-specific context from past sessions. Surfaces decisions, file change patterns, and session history."),
				mcp.WithTitleAnnotation("Project Recall"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("query", mcp.Description("Search query, file path, or directory path"), mcp.Required()),
				mcp.WithString("scope", mcp.Description("Search scope: file, directory, project, or all (auto-detected if omitted)")),
				mcp.WithString("project", mcp.Description("Project path filter")),
				mcp.WithNumber("limit", mcp.Description("Maximum results (default: 5)")),
			),
			Handler: recallHandler(st),
		},

		server.ServerTool{
			Tool: mcp.NewTool("review",
				mcp.WithDescription("Analyze your project's Claude Code utilization. Checks CLAUDE.md, skills, rules, hooks, MCP servers, and session history. Returns improvement suggestions."),
				mcp.WithTitleAnnotation("Project Review"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithString("project_path", mcp.Description("Project root path (cwd)")),
			),
			Handler: reviewHandler(claudeHome, st),
		},

		server.ServerTool{
			Tool: mcp.NewTool("ingest",
				mcp.WithDescription("Ingest documentation sections into the knowledge base. Stores sections with vector embeddings for semantic search."),
				mcp.WithTitleAnnotation("Document Ingestion"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithString("url", mcp.Required(), mcp.Description("Source URL of the documentation page")),
				mcp.WithArray("sections", mcp.Required(), mcp.Description("Array of {path, content} objects representing document sections"),
				objectItems("path", "content"),
			),
				mcp.WithString("source_type", mcp.Description("Document type: docs (default), changelog, engineering")),
				mcp.WithString("version", mcp.Description("CLI version (for changelog entries)")),
				mcp.WithNumber("ttl_days", mcp.Description("Time-to-live in days (default: 7)")),
			),
			Handler: ingestHandler(st, emb),
		},
	)

	return s
}
