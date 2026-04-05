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
import { atomicWriteJson } from "./state/atomic-write.ts";
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

// ── Gate name validation ────────────────────────────────────

/** Get all valid gate names from gates.json + session-policy + computational detectors. */
function getValidGateNames(cwd: string): string[] {
	const gatesPath = join(cwd, GATES_PATH);
	const gates = readJson<GatesConfig | null>(gatesPath, null);
	// "review" = session policy gate; others = computational detectors (no external command)
	const names = new Set<string>(["review", "security-check", "dead-import-check"]);
	if (gates) {
		for (const category of [gates.on_write, gates.on_commit, gates.on_review]) {
			if (category) {
				for (const name of Object.keys(category)) names.add(name);
			}
		}
	}
	return [...names];
}

function isValidGateName(name: string, cwd: string): boolean {
	return getValidGateNames(cwd).includes(name);
}

// ── Tool definitions ────────────────────────────────────────

interface ToolDef {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
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
	{
		name: "disable_gate",
		description:
			"Temporarily disable a gate for this session. The gate will not run on file edits or block commits. Use when a gate is broken or irrelevant for current work. Re-enable with enable_gate.",
		inputSchema: {
			type: "object",
			properties: {
				gate_name: {
					type: "string",
					description: "Gate name to disable (e.g. 'lint', 'typecheck', 'test')",
				},
			},
			required: ["gate_name"],
		},
	},
	{
		name: "enable_gate",
		description: "Re-enable a previously disabled gate.",
		inputSchema: {
			type: "object",
			properties: { gate_name: { type: "string", description: "Gate name to re-enable" } },
			required: ["gate_name"],
		},
	},
	{
		name: "set_config",
		description:
			"Set a qult config value in .qult/config.json. Allowed keys: review.score_threshold, review.max_iterations, review.required_changed_files, review.dimension_floor, plan_eval.score_threshold, plan_eval.max_iterations.",
		inputSchema: {
			type: "object",
			properties: {
				key: {
					type: "string",
					description: "Config key (e.g. 'review.score_threshold')",
				},
				value: {
					type: "number",
					description: "Numeric value to set",
				},
			},
			required: ["key", "value"],
		},
	},
	{
		name: "clear_pending_fixes",
		description:
			"Clear all pending lint/typecheck fixes. Use when fixes are false positives or already resolved outside qult.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "record_review",
		description:
			"Record that an independent review has been completed. Call this at the end of /qult:review after all stages pass. Required for the commit gate to allow commits.",
		inputSchema: {
			type: "object",
			properties: {
				aggregate_score: {
					type: "number",
					description: "Aggregate review score (e.g. 26 out of 30)",
				},
			},
		},
	},
	{
		name: "record_test_pass",
		description:
			"Record that tests have passed. Call after running tests successfully. Required for the commit gate to allow commits when on_commit gates are configured.",
		inputSchema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The test command that was run (e.g. 'bun vitest run')",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "record_stage_scores",
		description:
			"Record review scores for a specific stage (Spec, Quality, or Security). Call after each review stage passes with scores. Used for 3-stage aggregate score tracking.",
		inputSchema: {
			type: "object",
			properties: {
				stage: {
					type: "string",
					description: "Stage name: 'Spec', 'Quality', or 'Security'",
				},
				scores: {
					type: "object",
					description: "Dimension scores (e.g. {completeness: 5, accuracy: 4} for Spec stage)",
				},
			},
			required: ["stage", "scores"],
		},
	},
];

function handleTool(name: string, cwd: string, args?: Record<string, unknown>): ToolResult {
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
					content: [{ type: "text", text: "No gates configured. Run /qult:init." }],
				};
			}
			return { content: [{ type: "text", text: JSON.stringify(gates, null, 2) }] };
		}
		case "disable_gate": {
			const gateName = typeof args?.gate_name === "string" ? args.gate_name : null;
			if (!gateName) {
				return { isError: true, content: [{ type: "text", text: "Missing gate_name parameter." }] };
			}
			if (!isValidGateName(gateName, cwd)) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Unknown gate '${gateName}'. Valid gates: ${getValidGateNames(cwd).join(", ")}`,
						},
					],
				};
			}
			const statePath = findLatestStateFile(cwd, "session-state");
			const state = readJson<Record<string, unknown>>(statePath, {});
			const disabled = Array.isArray(state.disabled_gates) ? state.disabled_gates : [];
			if (!disabled.includes(gateName)) {
				disabled.push(gateName);
			}
			state.disabled_gates = disabled;
			try {
				atomicWriteJson(statePath, state);
				_jsonCache.delete(statePath);
			} catch {
				return { isError: true, content: [{ type: "text", text: "Failed to write state." }] };
			}
			return { content: [{ type: "text", text: `Gate '${gateName}' disabled for this session.` }] };
		}
		case "enable_gate": {
			const gateName = typeof args?.gate_name === "string" ? args.gate_name : null;
			if (!gateName) {
				return { isError: true, content: [{ type: "text", text: "Missing gate_name parameter." }] };
			}
			const statePath = findLatestStateFile(cwd, "session-state");
			const state = readJson<Record<string, unknown>>(statePath, {});
			const disabled = Array.isArray(state.disabled_gates) ? state.disabled_gates : [];
			state.disabled_gates = disabled.filter((g: unknown) => g !== gateName);
			try {
				atomicWriteJson(statePath, state);
				_jsonCache.delete(statePath);
			} catch {
				return { isError: true, content: [{ type: "text", text: "Failed to write state." }] };
			}
			return { content: [{ type: "text", text: `Gate '${gateName}' re-enabled.` }] };
		}
		case "set_config": {
			const key = typeof args?.key === "string" ? args.key : null;
			const value = typeof args?.value === "number" ? args.value : null;
			if (!key || value === null) {
				return {
					isError: true,
					content: [{ type: "text", text: "Missing key or value parameter." }],
				};
			}
			const ALLOWED_KEYS = [
				"review.score_threshold",
				"review.max_iterations",
				"review.required_changed_files",
				"review.dimension_floor",
				"plan_eval.score_threshold",
				"plan_eval.max_iterations",
			];
			if (!ALLOWED_KEYS.includes(key)) {
				return {
					isError: true,
					content: [
						{ type: "text", text: `Invalid key '${key}'. Allowed: ${ALLOWED_KEYS.join(", ")}` },
					],
				};
			}
			// Range validation for specific keys
			if (key === "review.dimension_floor" && (value < 1 || value > 5)) {
				return {
					isError: true,
					content: [{ type: "text", text: "dimension_floor must be between 1 and 5." }],
				};
			}
			const configPath = join(cwd, ".qult", "config.json");
			const config = readJson<Record<string, unknown>>(configPath, {});
			const [section, field] = key.split(".");
			if (!section || !field) {
				return { isError: true, content: [{ type: "text", text: "Invalid key format." }] };
			}
			if (!config[section] || typeof config[section] !== "object") {
				config[section] = {};
			}
			(config[section] as Record<string, unknown>)[field] = value;
			try {
				atomicWriteJson(configPath, config);
				_jsonCache.delete(configPath);
			} catch {
				return { isError: true, content: [{ type: "text", text: "Failed to write config." }] };
			}
			return { content: [{ type: "text", text: `Config set: ${key} = ${value}` }] };
		}
		case "clear_pending_fixes": {
			const fixesPath = findLatestStateFile(cwd, "pending-fixes");
			try {
				atomicWriteJson(fixesPath, []);
				_jsonCache.delete(fixesPath);
			} catch {
				return { isError: true, content: [{ type: "text", text: "Failed to clear fixes." }] };
			}
			return { content: [{ type: "text", text: "All pending fixes cleared." }] };
		}
		case "record_review": {
			const statePath = findLatestStateFile(cwd, "session-state");
			try {
				const state = readJson<Record<string, unknown>>(statePath, {});
				state.review_completed_at = new Date().toISOString();
				atomicWriteJson(statePath, state);
				_jsonCache.delete(statePath);
			} catch {
				return { isError: true, content: [{ type: "text", text: "Failed to record review." }] };
			}
			const score = typeof args?.aggregate_score === "number" ? args.aggregate_score : null;
			const msg = score !== null ? `Review recorded (aggregate: ${score}/30).` : "Review recorded.";
			return { content: [{ type: "text", text: msg }] };
		}
		case "record_test_pass": {
			const cmd = typeof args?.command === "string" ? args.command : null;
			if (!cmd) {
				return { isError: true, content: [{ type: "text", text: "Missing command parameter." }] };
			}
			const statePath = findLatestStateFile(cwd, "session-state");
			try {
				const state = readJson<Record<string, unknown>>(statePath, {});
				state.test_passed_at = new Date().toISOString();
				state.test_command = cmd;
				atomicWriteJson(statePath, state);
				_jsonCache.delete(statePath);
			} catch {
				return {
					isError: true,
					content: [{ type: "text", text: "Failed to record test pass." }],
				};
			}
			return { content: [{ type: "text", text: `Test pass recorded: ${cmd}` }] };
		}
		case "record_stage_scores": {
			const stage = typeof args?.stage === "string" ? args.stage : null;
			const scores = args?.scores;
			if (!stage || !scores || typeof scores !== "object") {
				return {
					isError: true,
					content: [{ type: "text", text: "Missing stage or scores parameter." }],
				};
			}
			const validStages = ["Spec", "Quality", "Security", "Adversarial"];
			if (!validStages.includes(stage)) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Invalid stage '${stage}'. Must be: ${validStages.join(", ")}`,
						},
					],
				};
			}
			const statePath = findLatestStateFile(cwd, "session-state");
			try {
				const state = readJson<Record<string, unknown>>(statePath, {});
				if (
					!state.review_stage_scores ||
					typeof state.review_stage_scores !== "object" ||
					Array.isArray(state.review_stage_scores)
				) {
					state.review_stage_scores = {};
				}
				(state.review_stage_scores as Record<string, unknown>)[stage] = scores;
				atomicWriteJson(statePath, state);
				_jsonCache.delete(statePath);
			} catch {
				return {
					isError: true,
					content: [{ type: "text", text: "Failed to record stage scores." }],
				};
			}
			return {
				content: [
					{ type: "text", text: `Stage scores recorded: ${stage} = ${JSON.stringify(scores)}` },
				],
			};
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
						"If gates are not configured, run /qult:init.",
						"",
						"## Quality Rules",
						"- ALWAYS write the test file FIRST, then implement.",
						"- At least 2 meaningful assertions per test case.",
						"- NEVER mark implementation as complete until tests pass.",
						"- Quick fix (no plan): keep changes focused, 1-2 files per logical change.",
						"- Planned work: follow the plan's task boundaries.",
						"",
						"## Plan Structure",
						"When writing a plan, use: ## Context, ## Tasks (### Task N with File/Change/Boundary/Verify), ## Success Criteria.",
						"Update task status to [done] as you complete each task.",
						"",
						"## Workflow",
						"- When requirements are unclear, use /qult:explore to interview the architect.",
						"- When debugging, use /qult:debug for structured root-cause analysis.",
						"- When finishing a branch, use /qult:finish for structured completion.",
						"- Independent 3-stage review (/qult:review) is required for large changes or when a plan is active.",
					].join("\n"),
				},
			};

		case "tools/list":
			return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } };

		case "tools/call": {
			const params = parsed.params as Record<string, unknown>;
			const toolName = params?.name;
			if (typeof toolName !== "string") {
				return {
					jsonrpc: "2.0",
					id,
					error: { code: -32602, message: "Missing tool name" },
				};
			}
			const toolArgs =
				typeof params?.arguments === "object"
					? (params.arguments as Record<string, unknown>)
					: undefined;
			return { jsonrpc: "2.0", id, result: handleTool(toolName, cwd, toolArgs) };
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
				process.stdout.write(`${JSON.stringify(response)}\n`);
			}
		} catch {
			// Malformed JSON → send parse error if we can guess an id
			process.stdout.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error" },
				})}\n`,
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
