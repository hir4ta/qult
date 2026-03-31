/**
 * qult MCP Server — exposes quality gate state to Claude via tools.
 *
 * Architecture: hooks write state to .qult/.state/ files (exit 2 for deny/block).
 * This read-only server lets Claude query that state via MCP tools.
 * Runs as stdio transport, spawned by Claude Code plugin system.
 *
 * Uses raw JSON-RPC over stdio (newline-delimited) instead of the MCP SDK
 * to eliminate the 660KB SDK dependency and reduce coupling to SDK releases.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { GatesConfig, PendingFix } from "./types.ts";

const STATE_DIR = ".qult/.state";
const GATES_PATH = ".qult/gates.json";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "qult";
const SERVER_VERSION = "1.0.0";

/** Cache TTL in ms — MCP tools are called infrequently, 2s prevents redundant reads. */
const CACHE_TTL_MS = 2000;

interface CacheEntry<T> {
	value: T;
	expires: number;
}

const _jsonCache = new Map<string, CacheEntry<unknown>>();

/** Read a JSON file with TTL cache, returning fallback on any error (fail-open). */
function readJson<T>(path: string, fallback: T): T {
	const now = Date.now();
	const cached = _jsonCache.get(path) as CacheEntry<T> | undefined;
	if (cached && cached.expires > now) return cached.value;

	try {
		if (!existsSync(path)) return fallback;
		const value = JSON.parse(readFileSync(path, "utf-8")) as T;
		_jsonCache.set(path, { value, expires: now + CACHE_TTL_MS });
		return value;
	} catch {
		return fallback;
	}
}

/**
 * Find the state file matching a prefix, preferring the session from latest-session.json.
 * Falls back to mtime-based selection if latest-session.json is missing or stale.
 */
function findLatestStateFile(cwd: string, prefix: string): string {
	const dir = join(cwd, STATE_DIR);
	const nonScoped = join(dir, `${prefix}.json`);
	try {
		if (!existsSync(dir)) return nonScoped;

		try {
			const markerPath = join(dir, "latest-session.json");
			if (existsSync(markerPath)) {
				const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
				if (marker?.session_id) {
					const scoped = join(dir, `${prefix}-${marker.session_id}.json`);
					if (existsSync(scoped)) return scoped;
				}
			}
		} catch {
			// fall through to mtime-based selection
		}

		const files = readdirSync(dir)
			.filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
			.map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		if (files.length === 0) return nonScoped;
		return join(dir, files[0]!.name);
	} catch {
		return nonScoped;
	}
}

/** Format pending fixes into a human-readable summary for Claude. */
function formatPendingFixes(fixes: PendingFix[]): string {
	const lines: string[] = [`${fixes.length} pending fix(es):\n`];
	for (const fix of fixes) {
		lines.push(`[${fix.gate}] ${fix.file}`);
		for (const err of fix.errors) {
			lines.push(`  ${err}`);
		}
	}
	return lines.join("\n");
}

// ── Tool definitions ────────────────────────────────────────

interface ToolDef {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, never> };
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

const TOOL_DEFS: ToolDef[] = [
	{
		name: "get_pending_fixes",
		description:
			"Returns lint/typecheck errors that must be fixed. Call when DENIED by qult. Response: '[gate] file\\n  error details' per fix, or 'No pending fixes.'",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_session_status",
		description:
			"Returns session state as JSON: test_passed_at, review_completed_at, changed_file_paths, review_iteration. Call before committing to verify gates.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_gate_config",
		description:
			"Returns gate definitions as JSON: on_write (lint/typecheck per file), on_commit (test), on_review (e2e). Each gate has command, timeout, optional run_once_per_batch.",
		inputSchema: { type: "object", properties: {} },
	},
];

function handleTool(name: string, cwd: string): ToolResult {
	switch (name) {
		case "get_pending_fixes": {
			const path = findLatestStateFile(cwd, "pending-fixes");
			const fixes = readJson<PendingFix[]>(path, []);
			if (!Array.isArray(fixes) || fixes.length === 0) {
				return { content: [{ type: "text", text: "No pending fixes." }] };
			}
			return { content: [{ type: "text", text: formatPendingFixes(fixes) }] };
		}
		case "get_session_status": {
			const path = findLatestStateFile(cwd, "session-state");
			const state = readJson<Record<string, unknown> | null>(path, null);
			if (!state) {
				return {
					isError: true,
					content: [{ type: "text", text: "No session state. Run /qult:init to set up." }],
				};
			}
			return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
		}
		case "get_gate_config": {
			const gatesPath = join(cwd, GATES_PATH);
			const gates = readJson<GatesConfig | null>(gatesPath, null);
			if (!gates) {
				return {
					isError: true,
					content: [{ type: "text", text: "No gates configured. Run /qult:detect-gates." }],
				};
			}
			return { content: [{ type: "text", text: JSON.stringify(gates, null, 2) }] };
		}
		default:
			return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
	}
}

// ── JSON-RPC dispatch ───────────────────────────────────────

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string };
}

/**
 * Handle a single JSON-RPC request. Pure function for testability.
 * Returns null for notifications (no id → no response).
 */
function handleRequest(parsed: JsonRpcRequest, cwd: string): JsonRpcResponse | null {
	const id = parsed.id;

	// Notifications (no id) → no response
	if (id === undefined || id === null) return null;

	switch (parsed.method) {
		case "initialize":
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
					instructions: [
						"qult enforces quality gates (lint, typecheck, test, review) via hooks.",
						"Hooks block tool use with exit 2 when violations exist.",
						"",
						"IMPORTANT: When a tool is DENIED by qult, call get_pending_fixes immediately.",
						"Before committing, call get_session_status to verify test/review gates.",
						"If gates are not configured, run /qult:detect-gates.",
					].join("\n"),
				},
			};

		case "tools/list":
			return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } };

		case "tools/call": {
			const toolName = (parsed.params as Record<string, unknown>)?.name;
			if (typeof toolName !== "string") {
				return {
					jsonrpc: "2.0",
					id,
					error: { code: -32602, message: "Missing tool name" },
				};
			}
			return { jsonrpc: "2.0", id, result: handleTool(toolName, cwd) };
		}

		case "ping":
			return { jsonrpc: "2.0", id, result: {} };

		default:
			return {
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `Method not found: ${parsed.method}` },
			};
	}
}

// ── stdio transport ─────────────────────────────────────────

async function main(): Promise<void> {
	const cwd = process.env.QULT_CWD ?? process.cwd();

	const rl = createInterface({ input: process.stdin });

	for await (const line of rl) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as JsonRpcRequest;
			const response = handleRequest(parsed, cwd);
			if (response) {
				process.stdout.write(JSON.stringify(response) + "\n");
			}
		} catch {
			// Malformed JSON → send parse error if we can guess an id
			process.stdout.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error" },
				}) + "\n",
			);
		}
	}
}

main().catch((err) => {
	process.stderr.write(`[qult-mcp] Fatal: ${err}\n`);
	process.exit(1);
});

/** Reset MCP read cache (for tests). */
function resetMcpCache(): void {
	_jsonCache.clear();
}

export { findLatestStateFile, handleRequest, handleTool, readJson, resetMcpCache, TOOL_DEFS };
