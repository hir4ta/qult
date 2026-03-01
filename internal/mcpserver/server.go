package mcpserver

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/hookhandler"
	"github.com/hir4ta/claude-alfred/internal/sessiondb"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// withAlfredTracker wraps a handler to reset the silence-as-signal counter
// whenever an alfred MCP tool is invoked. This signals to the Thompson Sampling
// system that the user is actively engaging with alfred suggestions.
func withAlfredTracker(st *store.Store, h server.ToolHandlerFunc) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		resetAlfredTracker(st)
		return h(ctx, req)
	}
}

func resetAlfredTracker(st *store.Store) {
	if st == nil {
		return
	}
	sid := latestSessionID(st)
	if sid == "" || sid == "unknown" {
		return
	}
	sdb, err := sessiondb.Open(sid)
	if err != nil {
		return
	}
	defer sdb.Close()
	hookhandler.ResetAlfredCallTracker(sdb)
}

const serverInstructions = `claude-alfred is a real-time session advisor for Claude Code.
Hook-based briefings are delivered automatically every turn.

## When you need more detail from a briefing:
  knowledge — Search docs, decisions, and solutions
  guidance — Get alerts, recommendations, next steps
  diagnose — Root cause analysis + fix patches for errors

## Session management:
  state — Session health, statistics, and predictions
  plan — Task estimation, progress tracking, strategic plans
  feedback — Rate suggestion quality (improves future relevance)

## Knowledge base:
  ingest — Store documentation sections with vector embeddings
`

// New creates a new MCP server with all tools registered.
// emb may be nil if VOYAGE_API_KEY is not set.
func New(claudeHome string, st *store.Store, emb *embedder.Embedder) *server.MCPServer {
	s := server.NewMCPServer(
		"claude-alfred",
		"0.3.0",
		server.WithToolCapabilities(true),
		server.WithResourceCapabilities(true, true),
		server.WithPromptCapabilities(true),
		server.WithInstructions(serverInstructions),
		server.WithLogging(),
	)

	s.AddTools(
		// 1. state: Consolidated session state + sessions + resume + skill_context + accuracy.
		server.ServerTool{
			Tool: mcp.NewTool("state",
				mcp.WithDescription("Get session health, statistics, burst state, and trend predictions. Use when you need to assess current session progress, check health metrics, or predict potential issues. The 'detail' parameter controls depth: 'brief' returns stats only, 'standard' (default) returns a full snapshot including burst state and phase, 'outlook' adds health trends and risk predictions, 'sessions' lists recent sessions, 'resume' restores context from a previous session, 'skill' returns skill-specific context, 'accuracy' returns suggestion accuracy metrics."),
				mcp.WithTitleAnnotation("Session State"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("detail",
					mcp.Description("Level of detail: brief (stats), standard (default, full snapshot), outlook (health + phase + risk), sessions (list recent), resume (restore context), skill (skill-specific context), accuracy (suggestion metrics)"),
				),
				mcp.WithString("session_id",
					mcp.Description("Session ID (optional, defaults to latest)"),
				),
				mcp.WithString("project",
					mcp.Description("Project name or path to filter (for resume)"),
				),
				mcp.WithString("skill_name",
					mcp.Description("Skill name (required when detail=skill)"),
				),
				mcp.WithNumber("limit",
					mcp.Description("Number of sessions for brief/sessions mode (default: 1/10)"),
				),
				mcp.WithString("format",
					mcp.Description("Response format: concise (summary + key data only) or detailed (default, full output)"),
				),
			),
			Handler: withAlfredTracker(st, stateConsolidatedHandler(claudeHome, st)),
		},

		// 2. knowledge: Consolidated knowledge search + recall.
		server.ServerTool{
			Tool: mcp.NewTool("knowledge",
				mcp.WithDescription("Search the alfred knowledge base including Claude Code documentation, design decisions, and cross-project insights. Uses vector search (Voyage AI) with FTS5 and LIKE fallbacks. Set 'scope' to 'global' for cross-project search, 'recall' to search pre-compact conversation history, or 'project' (default) for docs + decisions. 'type' filters by kind: docs (default), decision, all."),
				mcp.WithTitleAnnotation("Knowledge Search"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("query",
					mcp.Description("Search query (required)"),
					mcp.Required(),
				),
				mcp.WithString("scope",
					mcp.Description("Search scope: project (default), global (cross-project), or recall (pre-compact history)"),
				),
				mcp.WithString("type",
					mcp.Description("Filter: all (default), error_solution, architecture, decision, tool_usage"),
				),
				mcp.WithString("session_id",
					mcp.Description("Session ID to filter decisions or recall search"),
				),
				mcp.WithString("project",
					mcp.Description("Project name to filter"),
				),
				mcp.WithNumber("limit",
					mcp.Description("Maximum results (default: 5)"),
				),
				mcp.WithNumber("segment",
					mcp.Description("Compact segment for recall (0=pre-compact)"),
				),
				mcp.WithString("format",
					mcp.Description("Response format: concise (summary + key data only) or detailed (default, full output)"),
				),
			),
			Handler: withAlfredTracker(st, knowledgeConsolidatedHandler(st, emb)),
		},

		// 3. guidance: Consolidated guidance.
		server.ServerTool{
			Tool: mcp.NewTool("guidance",
				mcp.WithDescription("Get workflow guidance including active alerts, actionable recommendations, suggested next steps, and pending nudges. Use when you want to check what alfred recommends doing next, review outstanding warnings, or see queued suggestions. The 'focus' parameter narrows results: 'alerts' for warnings only, 'recommendations' for suggestions, 'next_steps' for prioritized actions, 'pending' for queued nudges."),
				mcp.WithTitleAnnotation("Workflow Guidance"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("focus",
					mcp.Description("Focus area: all (default), alerts, recommendations, next_steps, pending"),
				),
				mcp.WithString("session_id",
					mcp.Description("Session ID (optional, defaults to latest)"),
				),
				mcp.WithString("context",
					mcp.Description("Additional context for next_steps recommendations"),
				),
				mcp.WithString("format",
					mcp.Description("Response format: concise (summary + key data only) or detailed (default, full output)"),
				),
			),
			Handler: withAlfredTracker(st, guidanceConsolidatedHandler(claudeHome, st)),
		},

		// 4. plan: Consolidated planning.
		server.ServerTool{
			Tool: mcp.NewTool("plan",
				mcp.WithDescription("Plan and estimate tasks using historical session data for complexity estimation, multi-session progress tracking, and strategic workflow planning. Use when starting a new task to get effort estimates, checking progress on ongoing work, or generating an optimal phase sequence. The 'mode' parameter selects the function: 'estimate' returns median tool counts, 'progress' shows tracking, 'strategy' generates a phase-sequenced plan."),
				mcp.WithTitleAnnotation("Planning"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("mode",
					mcp.Description("Mode: estimate (task complexity), progress (multi-session tracking), strategy (optimal workflow), all"),
				),
				mcp.WithString("task_type",
					mcp.Description("Task type: bugfix, feature, refactor, test, explore, debug"),
				),
				mcp.WithString("project",
					mcp.Description("Project path"),
				),
				mcp.WithString("session_id",
					mcp.Description("Session ID for progress tracking"),
				),
				mcp.WithString("format",
					mcp.Description("Response format: concise (summary + key data only) or detailed (default, full output)"),
				),
			),
			Handler: withAlfredTracker(st, planConsolidatedHandler(st)),
		},

		// 5. diagnose: Consolidated diagnosis + fix.
		server.ServerTool{
			Tool: mcp.NewTool("diagnose",
				mcp.WithDescription("Diagnose errors and generate concrete fix patches with before/after code and verification commands. Use when a tool produces an error you need to understand, or when code quality findings need automated fixes. Provide 'error_output' for error diagnosis, or 'file_path' with 'finding_rule' for code fix generation. Supports Go compile errors, test failure correlation, and AST-based code fixes."),
				mcp.WithTitleAnnotation("Error Diagnosis & Fix"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("error_output",
					mcp.Description("Error message or command output to diagnose"),
				),
				mcp.WithString("tool_name",
					mcp.Description("Tool that produced the error (e.g., 'Bash', 'Edit')"),
				),
				mcp.WithString("file_path",
					mcp.Description("File path related to the error or containing the finding"),
				),
				mcp.WithString("finding_rule",
					mcp.Description("Code quality rule identifier for fix generation"),
				),
				mcp.WithString("message",
					mcp.Description("Finding message text (for fix generation when rule is not known)"),
				),
				mcp.WithNumber("line",
					mcp.Description("Line number of the finding"),
				),
				mcp.WithString("format",
					mcp.Description("Response format: concise (summary + key data only) or detailed (default, full output)"),
				),
			),
			Handler: withAlfredTracker(st, diagnoseConsolidatedHandler(st)),
		},

		// 6. ingest: Document ingestion (write operation).
		server.ServerTool{
			Tool: mcp.NewTool("ingest",
				mcp.WithDescription("Ingest documentation sections into the alfred knowledge base. Accepts a URL with an array of sections (path + content), stores them in the docs table, and generates vector embeddings for semantic search. Use with /alfred-crawl to populate the knowledge base from Claude Code documentation."),
				mcp.WithTitleAnnotation("Document Ingestion"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("url",
					mcp.Required(),
					mcp.Description("Source URL of the documentation page"),
				),
				mcp.WithObject("sections",
					mcp.Required(),
					mcp.Description("Array of {path, content} objects representing document sections"),
				),
				mcp.WithString("source_type",
					mcp.Description("Document type: docs (default), changelog, engineering"),
				),
				mcp.WithString("version",
					mcp.Description("CLI version (for changelog entries)"),
				),
				mcp.WithNumber("ttl_days",
					mcp.Description("Time-to-live in days (default: 7)"),
				),
				mcp.WithString("format",
					mcp.Description("Response format: concise (summary + key data only) or detailed (default, full output)"),
				),
			),
			Handler: withAlfredTracker(st, ingestHandler(st, emb)),
		},

		// 7. feedback: Suggestion feedback (write operation — separate annotations).
		server.ServerTool{
			Tool: mcp.NewTool("feedback",
				mcp.WithDescription("Rate the quality of an alfred suggestion to improve future relevance via Thompson Sampling. Use when a suggestion was particularly helpful or unhelpful and you want to provide explicit signal. The required 'pattern' identifies which suggestion to rate; 'rating' must be helpful, partially_helpful, not_helpful, or misleading. Explicit feedback overrides automatic inference and has lasting impact on prioritization."),
				mcp.WithTitleAnnotation("Suggestion Feedback"),
				mcp.WithReadOnlyHintAnnotation(false),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(false),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("pattern",
					mcp.Required(),
					mcp.Description("The suggestion pattern name"),
				),
				mcp.WithString("rating",
					mcp.Required(),
					mcp.Description("Rating: helpful, partially_helpful, not_helpful, or misleading"),
				),
				mcp.WithNumber("suggestion_id",
					mcp.Description("Specific suggestion outcome ID"),
				),
				mcp.WithString("comment",
					mcp.Description("Additional feedback details"),
				),
				mcp.WithString("format",
					mcp.Description("Response format: concise (summary + key data only) or detailed (default, full output)"),
				),
			),
			Handler: withAlfredTracker(st, feedbackHandler(st)),
		},
	)

	// Register resources and prompts.
	registerResources(s, claudeHome, st)
	registerPrompts(s, claudeHome, st)

	return s
}
