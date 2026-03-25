import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Embedder } from "../embedder/index.js";
import type { Store } from "../store/index.js";

const SERVER_INSTRUCTIONS = `alfred is your quality butler for Claude Code.

When to use alfred:
- Search past error resolutions, code exemplars, or conventions → action=search
- Save a new error resolution, exemplar, or convention → action=save
- Check project profile (language, test framework, linter) → action=profile
- View quality score for current session → action=score
`;

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function createMCPServer(store: Store, emb: Embedder | null, version: string): McpServer {
	const server = new McpServer({ name: "alfred", version }, { instructions: SERVER_INSTRUCTIONS });

	server.tool(
		"alfred",
		`Quality knowledge management — search, save, and track code quality across sessions.

Actions:
- search: Search error resolutions, exemplars, conventions via Voyage vector search
- save: Save a new knowledge entry (error_resolution, exemplar, or convention)
- profile: Show/refresh project profile (language, test framework, linter, gates)
- score: Show quality score for current or specified session`,
		{
			action: z
				.enum(["search", "save", "profile", "score"])
				.describe("Action to perform"),
			// search params
			query: z.string().optional().describe("Search query (for search)"),
			type: z
				.enum(["error_resolution", "exemplar", "convention", "all"])
				.optional()
				.describe("Knowledge type filter (for search, default: all)"),
			scope: z
				.enum(["project", "global"])
				.optional()
				.describe("Search scope (default: project)"),
			limit: z.number().optional().describe("Max results (for search, default: 5)"),
			// save params
			title: z.string().optional().describe("Title (REQUIRED for save)"),
			// error_resolution fields
			error_signature: z.string().optional().describe("Normalized error message (for error_resolution)"),
			resolution: z.string().optional().describe("How to resolve the error (for error_resolution)"),
			// exemplar fields
			bad: z.string().optional().describe("Before code (for exemplar)"),
			good: z.string().optional().describe("After code (for exemplar)"),
			explanation: z.string().optional().describe("Why the good version is better (for exemplar)"),
			// convention fields
			pattern: z.string().optional().describe("Convention description (for convention)"),
			category: z.string().optional().describe("Convention category: naming|imports|error-handling|testing|architecture|style"),
			example_files: z.string().optional().describe("Comma-separated reference file paths (for convention)"),
			// common
			tags: z.string().optional().describe("Comma-separated tags"),
			project_path: z.string().optional().describe("Project root path (defaults to cwd)"),
			// profile params
			refresh: z.boolean().optional().describe("Re-scan project (for profile)"),
			// score params
			session_id: z.string().optional().describe("Session ID (for score, default: current)"),
		},
		async (params) => {
			// TODO (Phase 1): Implement alfred tool handlers
			switch (params.action) {
				case "search":
					return jsonResult({ status: "not_implemented", message: "Phase 1: search" });
				case "save":
					return jsonResult({ status: "not_implemented", message: "Phase 1: save" });
				case "profile":
					return jsonResult({ status: "not_implemented", message: "Phase 1: profile" });
				case "score":
					return jsonResult({ status: "not_implemented", message: "Phase 1: score" });
				default:
					return jsonResult({ error: `Unknown action: ${params.action}` });
			}
		},
	);

	return server;
}

export async function serveMCP(store: Store, emb: Embedder | null, version: string): Promise<void> {
	const server = createMCPServer(store, emb, version);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
