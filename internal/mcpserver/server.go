package mcpserver

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/embedder"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/store"
)

const serverInstructions = `claude-buddy is a real-time session advisor for Claude Code. It monitors your session, detects anti-patterns, and provides proactive workflow guidance.

## Available Tools

- buddy_stats: Get session statistics (turn counts, tool usage, duration). Use to understand session patterns.
- buddy_suggest: Get prioritized workflow recommendations with health score, alerts, and feature utilization.
- buddy_current_state: Quick pulse check — session health, burst state, predictions, and active alerts.
- buddy_sessions: List recent sessions by project or date.
- buddy_resume: Recover context from a previous session (summary, decisions, files modified).
- buddy_recall: Search pre-compact conversation history for lost details (topics, file paths, decisions).
- buddy_alerts: Detect active anti-patterns and get session health score.
- buddy_decisions: List past design decisions. Use before making related changes to check architectural history.
- buddy_patterns: Search knowledge patterns (error solutions, architecture, decisions) from past sessions.
- buddy_estimate: Estimate task complexity based on historical workflow data.

## Usage Guidelines

- Call buddy_current_state at session start for a health baseline.
- Call buddy_alerts when health score drops below 0.7.
- Call buddy_patterns when encountering errors to find past solutions.
- Call buddy_decisions before architectural changes.
- Call buddy_recall after context compaction to recover lost details.
- Call buddy_estimate before starting complex tasks to set expectations.
`

// New creates a new MCP server with all tools registered.
// emb may be nil if Ollama is not available.
func New(claudeHome string, lang locale.Lang, st *store.Store, emb *embedder.Embedder) *server.MCPServer {
	s := server.NewMCPServer(
		"claude-buddy",
		"0.2.0",
		server.WithToolCapabilities(true),
		server.WithResourceCapabilities(true, true),
		server.WithPromptCapabilities(true),
		server.WithInstructions(serverInstructions),
		server.WithLogging(),
	)

	s.AddTools(
		server.ServerTool{
			Tool: mcp.NewTool("buddy_stats",
				mcp.WithDescription("Get usage statistics for Claude Code sessions. Returns turn counts, tool usage frequency, and session duration. Use to understand session patterns."),
				mcp.WithTitleAnnotation("Session Statistics"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("session_id",
					mcp.Description("Session ID to analyze (optional, defaults to most recent)"),
				),
				mcp.WithNumber("limit",
					mcp.Description("Number of recent sessions to include (default: 1)"),
				),
			),
			Handler: statsHandler(claudeHome),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_suggest",
				mcp.WithDescription("Get structured usage recommendations for a Claude Code session. Returns session health, active alerts, usage hints, feature utilization, and prioritized recommendations. Use to improve Claude Code workflow."),
				mcp.WithTitleAnnotation("Usage Recommendations"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("session_id",
					mcp.Description("Session ID to analyze (optional, defaults to most recent)"),
				),
			),
			Handler: suggestHandler(claudeHome, lang),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_current_state",
				mcp.WithDescription("Get real-time session snapshot including stats, burst state, health score, predictions, and feature utilization. Use for quick pulse check on session health."),
				mcp.WithTitleAnnotation("Session State"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("session_id",
					mcp.Description("Session ID (optional, defaults to latest)"),
				),
			),
			Handler: currentStateHandler(claudeHome, lang),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_sessions",
				mcp.WithDescription("List recent Claude Code sessions with basic metadata. Use to find sessions by project or date."),
				mcp.WithTitleAnnotation("Recent Sessions"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithNumber("limit",
					mcp.Description("Maximum number of sessions to return (default: 10)"),
				),
			),
			Handler: sessionsHandler(claudeHome),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_resume",
				mcp.WithDescription("Resume context from a previous Claude Code session. Call this at session start to recover prior context. Returns summary, recent events, decisions, and files modified."),
				mcp.WithTitleAnnotation("Resume Context"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("session_id",
					mcp.Description("Session ID to resume from (optional, defaults to most recent)"),
				),
				mcp.WithString("project",
					mcp.Description("Project name or path to filter sessions (optional)"),
				),
			),
			Handler: resumeHandler(st),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_recall",
				mcp.WithDescription("Recall details lost during auto-compact. Searches pre-compact conversation history for specific topics, file paths, or decisions. Call this when you notice context has been compacted and need specific details."),
				mcp.WithTitleAnnotation("Recall Details"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("query",
					mcp.Description("Search query for finding specific details"),
					mcp.Required(),
				),
				mcp.WithString("session_id",
					mcp.Description("Session ID to search in (optional, defaults to most recent)"),
				),
				mcp.WithNumber("segment",
					mcp.Description("Compact segment to search (0=pre-compact, default: 0)"),
				),
				mcp.WithNumber("limit",
					mcp.Description("Maximum number of results to return (default: 10)"),
				),
			),
			Handler: recallHandler(st),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_alerts",
				mcp.WithDescription("Detect anti-patterns in Claude Code sessions. Returns active alerts and session health score. Use to check session health."),
				mcp.WithTitleAnnotation("Anti-pattern Alerts"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("session_id",
					mcp.Description("Session ID (optional, defaults to latest)"),
				),
			),
			Handler: alertsHandler(claudeHome, lang),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_decisions",
				mcp.WithDescription("List design decisions from past sessions. Use before making related changes to check past architectural choices."),
				mcp.WithTitleAnnotation("Design Decisions"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("session_id",
					mcp.Description("Session ID to filter decisions (optional)"),
				),
				mcp.WithString("project",
					mcp.Description("Project name to filter decisions (optional)"),
				),
				mcp.WithString("query",
					mcp.Description("Search query to find specific decisions (optional)"),
				),
				mcp.WithNumber("limit",
					mcp.Description("Maximum number of decisions to return (default: 20)"),
				),
			),
			Handler: decisionsHandler(st),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_patterns",
				mcp.WithDescription("Search knowledge patterns from past sessions (error solutions, architecture, decisions). Use to find reusable patterns and prior solutions."),
				mcp.WithTitleAnnotation("Knowledge Patterns"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("query",
					mcp.Description("Search query (required)"),
					mcp.Required(),
				),
				mcp.WithString("type",
					mcp.Description("Pattern type filter: error_solution, architecture, tool_usage, decision (optional)"),
				),
				mcp.WithNumber("limit",
					mcp.Description("Maximum results (default: 5)"),
				),
			),
			Handler: patternsHandler(st, emb),
		},
		server.ServerTool{
			Tool: mcp.NewTool("buddy_estimate",
				mcp.WithDescription("Estimate task complexity based on historical workflow data. Returns median tool count, success rate, and common workflow pattern."),
				mcp.WithTitleAnnotation("Task Estimation"),
				mcp.WithReadOnlyHintAnnotation(true),
				mcp.WithDestructiveHintAnnotation(false),
				mcp.WithIdempotentHintAnnotation(true),
				mcp.WithOpenWorldHintAnnotation(false),
				mcp.WithString("task_type",
					mcp.Description("Task type: bugfix, feature, refactor, research, review"),
					mcp.Required(),
				),
				mcp.WithString("project",
					mcp.Description("Project path to filter estimates (optional)"),
				),
			),
			Handler: estimateHandler(st),
		},
	)

	// Register resources and prompts.
	registerResources(s, claudeHome, lang, st)
	registerPrompts(s, claudeHome, lang, st)

	return s
}
