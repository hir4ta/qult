/**
 * qult MCP Server — exposes quality gate state to Claude via tools.
 *
 * Architecture: hooks write state to .qult/.state/ files (exit 2 for deny/block).
 * This read-only server lets Claude query that state via MCP tools.
 * Runs as stdio transport, spawned by Claude Code plugin system.
 *
 * @see https://modelcontextprotocol.io/docs/concepts/servers
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { GatesConfig, PendingFix } from "./types.ts";

const STATE_DIR = ".qult/.state";
const GATES_PATH = ".qult/gates.json";

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

		// Prefer session from latest-session.json (written by hooks)
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

function createServer(cwd: string): McpServer {
	const server = new McpServer(
		{ name: "qult", version: "1.0.0" },
		{
			instructions: [
				"qult enforces quality gates (lint, typecheck, test, review) via hooks.",
				"Hooks block tool use with exit 2 when violations exist.",
				"",
				"IMPORTANT: When a tool is DENIED by qult, call get_pending_fixes immediately.",
				"Before committing, call get_session_status to verify test/review gates.",
				"If gates are not configured, run /qult:detect-gates.",
			].join("\n"),
		},
	);

	server.tool(
		"get_pending_fixes",
		"Returns lint/typecheck errors that must be fixed. Call when DENIED by qult. Response: '[gate] file\\n  error details' per fix, or 'No pending fixes.'",
		{},
		() => {
			const path = findLatestStateFile(cwd, "pending-fixes");
			const fixes = readJson<PendingFix[]>(path, []);
			if (!Array.isArray(fixes) || fixes.length === 0) {
				return { content: [{ type: "text" as const, text: "No pending fixes." }] };
			}
			return {
				content: [{ type: "text" as const, text: formatPendingFixes(fixes) }],
			};
		},
	);

	server.tool(
		"get_session_status",
		"Returns session state as JSON: test_passed_at, review_completed_at, changed_file_paths, review_iteration. Call before committing to verify gates.",
		{},
		() => {
			const path = findLatestStateFile(cwd, "session-state");
			const state = readJson<Record<string, unknown> | null>(path, null);
			if (!state) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "No session state. Run /qult:init to set up." }],
				};
			}
			return {
				content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
			};
		},
	);

	server.tool(
		"get_gate_config",
		"Returns gate definitions as JSON: on_write (lint/typecheck per file), on_commit (test), on_review (e2e). Each gate has command, timeout, optional run_once_per_batch.",
		{},
		() => {
			const gatesPath = join(cwd, GATES_PATH);
			const gates = readJson<GatesConfig | null>(gatesPath, null);
			if (!gates) {
				return {
					isError: true,
					content: [
						{ type: "text" as const, text: "No gates configured. Run /qult:detect-gates." },
					],
				};
			}
			return {
				content: [{ type: "text" as const, text: JSON.stringify(gates, null, 2) }],
			};
		},
	);

	return server;
}

async function main(): Promise<void> {
	const cwd = process.env.QULT_CWD ?? process.cwd();
	const server = createServer(cwd);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	process.stderr.write(`[qult-mcp] Fatal: ${err}\n`);
	process.exit(1);
});

/** Reset MCP read cache (for tests). */
function resetMcpCache(): void {
	_jsonCache.clear();
}

export { createServer, findLatestStateFile, readJson, resetMcpCache };
