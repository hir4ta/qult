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
import { loadConfig } from "./config.ts";
import { generateHandoffDocument } from "./handoff.ts";
import { generateHarnessReport } from "./harness-report.ts";
import { generateMetricsDashboard } from "./metrics-dashboard.ts";
import { atomicWriteJson } from "./state/atomic-write.ts";
import { appendAuditLog, readAuditLog } from "./state/audit-log.ts";
import { readMetricsHistory } from "./state/metrics.ts";
import { getActivePlan, hasPlanFile } from "./state/plan-status.ts";
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
	const names = new Set<string>([
		"review",
		"security-check",
		"dead-import-check",
		"duplication-check",
	]);
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
			"Temporarily disable a gate for this session. The gate will not run on file edits or block commits. Use when a gate is broken or irrelevant for current work. Re-enable with enable_gate. Maximum 2 gates can be disabled per session.",
		inputSchema: {
			type: "object",
			properties: {
				gate_name: {
					type: "string",
					description: "Gate name to disable (e.g. 'lint', 'typecheck', 'test')",
				},
				reason: {
					type: "string",
					description: "Why this gate should be disabled (min 10 chars). Required for audit trail.",
				},
			},
			required: ["gate_name", "reason"],
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
		inputSchema: {
			type: "object",
			properties: {
				reason: {
					type: "string",
					description:
						"Why pending fixes should be cleared (min 10 chars). Required for audit trail.",
				},
			},
			required: ["reason"],
		},
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
					description: "Aggregate review score (e.g. 34 out of 40 for 4-stage review)",
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
		name: "get_detector_summary",
		description:
			"Returns a consolidated summary of all computational detector findings from the current session. Includes escalation counters (security, dead-import, drift, test-quality, duplication warnings) and pending fixes grouped by gate. Call before /qult:review to collect ground truth for reviewers.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "record_human_approval",
		description:
			"Record that the architect has reviewed and approved the changes. Required when review.require_human_approval is enabled in config. Call after the human has reviewed the code.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "record_stage_scores",
		description:
			"Record review scores for a specific stage (Spec, Quality, Security, or Adversarial). Call after each review stage passes with scores. Used for 4-stage aggregate score tracking (/40).",
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
	{
		name: "get_harness_report",
		description:
			"Returns a harness effectiveness report analyzing which gates catch issues, review score trends, and recommendations for unused gates. Call to assess harness health.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_handoff_document",
		description:
			"Returns a structured handoff document for starting a fresh session. Includes session state, plan progress, pending fixes, and changed files. Call before ending a long session or when context is degraded.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_metrics_dashboard",
		description:
			"Returns a formatted metrics dashboard showing gate failure trends, security warning trends, and review score history across recent sessions.",
		inputSchema: { type: "object", properties: {} },
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
			const reason = typeof args?.reason === "string" ? args.reason : null;
			if (!gateName) {
				return { isError: true, content: [{ type: "text", text: "Missing gate_name parameter." }] };
			}
			if (!reason || reason.length < 10 || new Set(reason).size < 5) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Missing or insufficient reason parameter (min 10 chars, min 5 unique characters). Explain WHY the gate should be disabled.",
						},
					],
				};
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
			// Max 2 gates disabled per session
			if (!disabled.includes(gateName) && disabled.length >= 2) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Maximum 2 gates can be disabled per session. Currently disabled: ${disabled.join(", ")}. Re-enable a gate first.`,
						},
					],
				};
			}
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
			appendAuditLog(cwd, {
				action: "disable_gate",
				reason,
				gate_name: gateName,
				timestamp: new Date().toISOString(),
			});
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
			const reason = typeof args?.reason === "string" ? args.reason : null;
			if (!reason || reason.length < 10 || new Set(reason).size < 5) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Missing or insufficient reason parameter (min 10 chars, min 5 unique characters). Explain WHY pending fixes should be cleared.",
						},
					],
				};
			}
			const fixesPath = findLatestStateFile(cwd, "pending-fixes");
			try {
				atomicWriteJson(fixesPath, []);
				_jsonCache.delete(fixesPath);
			} catch {
				return { isError: true, content: [{ type: "text", text: "Failed to clear fixes." }] };
			}
			appendAuditLog(cwd, {
				action: "clear_pending_fixes",
				reason,
				timestamp: new Date().toISOString(),
			});
			return { content: [{ type: "text", text: "All pending fixes cleared." }] };
		}
		case "get_detector_summary": {
			const statePath = findLatestStateFile(cwd, "session-state");
			const state = readJson<Record<string, unknown>>(statePath, {});
			const fixesPath = findLatestStateFile(cwd, "pending-fixes");
			const fixes = readJson<PendingFix[]>(fixesPath, []);

			const lines: string[] = [];

			// Escalation counters
			const counters = [
				"security_warning_count",
				"dead_import_warning_count",
				"drift_warning_count",
				"test_quality_warning_count",
				"duplication_warning_count",
			] as const;
			for (const key of counters) {
				const val = typeof state[key] === "number" ? (state[key] as number) : 0;
				if (val > 0) lines.push(`${key}: ${val}`);
			}

			// Pending fixes grouped by gate (use project-relative paths)
			if (Array.isArray(fixes) && fixes.length > 0) {
				const byGate: Record<string, PendingFix[]> = {};
				for (const fix of fixes) {
					const g = fix.gate ?? "unknown";
					if (!byGate[g]) byGate[g] = [];
					byGate[g].push(fix);
				}
				for (const [gate, gateFixes] of Object.entries(byGate)) {
					lines.push(`\n[${gate}] ${gateFixes.length} issue(s):`);
					for (const fix of gateFixes) {
						const relPath = fix.file.startsWith(`${cwd}/`)
							? fix.file.slice(cwd.length + 1)
							: fix.file;
						lines.push(`  ${relPath}`);
						for (const err of fix.errors.slice(0, 3)) {
							lines.push(`    ${err.slice(0, 200)}`);
						}
					}
				}
			}

			if (lines.length === 0) {
				return { content: [{ type: "text", text: "No detector findings." }] };
			}
			return { content: [{ type: "text", text: lines.join("\n") }] };
		}
		case "record_review": {
			const statePath = findLatestStateFile(cwd, "session-state");
			const state = readJson<Record<string, unknown>>(statePath, {});

			// Plan-required enforcement: refuse if many files changed without a plan
			try {
				const changedPaths = Array.isArray(state.changed_file_paths)
					? state.changed_file_paths
					: [];
				const threshold = loadConfig().review.required_changed_files;

				if (changedPaths.length >= threshold && !hasPlanFile()) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Cannot record review: ${changedPaths.length} files changed without a plan. Run /qult:plan-generator first.`,
							},
						],
					};
				}
			} catch {
				/* fail-open: if state read fails, allow record_review */
			}

			try {
				state.review_completed_at = new Date().toISOString();
				atomicWriteJson(statePath, state);
				_jsonCache.delete(statePath);
			} catch {
				return { isError: true, content: [{ type: "text", text: "Failed to record review." }] };
			}
			const score = typeof args?.aggregate_score === "number" ? args.aggregate_score : null;
			const msg = score !== null ? `Review recorded (aggregate: ${score}).` : "Review recorded.";
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
		case "record_human_approval": {
			// Guard: require that review has been completed first
			const haStatePath = findLatestStateFile(cwd, "session-state");
			const haState = readJson<Record<string, unknown>>(haStatePath, {});
			if (!haState.review_completed_at) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Cannot record human approval: no review has been completed yet. Run /qult:review first.",
						},
					],
				};
			}
			try {
				haState.human_review_approved_at = new Date().toISOString();
				atomicWriteJson(haStatePath, haState);
				_jsonCache.delete(haStatePath);
			} catch {
				return { isError: true, content: [{ type: "text", text: "Failed to record approval." }] };
			}
			appendAuditLog(cwd, {
				action: "record_human_approval",
				reason: "Architect approved changes",
				timestamp: new Date().toISOString(),
			});
			return { content: [{ type: "text", text: "Human approval recorded." }] };
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
		case "get_harness_report": {
			try {
				const metrics = readMetricsHistory(cwd);
				const auditLog = readAuditLog(cwd);
				const report = generateHarnessReport(metrics, auditLog);
				return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
			} catch {
				return { content: [{ type: "text", text: "No harness data available yet." }] };
			}
		}
		case "get_handoff_document": {
			try {
				const statePath = findLatestStateFile(cwd, "session-state");
				const state = readJson<Record<string, unknown>>(statePath, {});
				const fixesPath = findLatestStateFile(cwd, "pending-fixes");
				const fixes = readJson<PendingFix[]>(fixesPath, []);
				const plan = getActivePlan();
				return {
					content: [
						{
							type: "text",
							text: generateHandoffDocument({
								changedFiles: Array.isArray(state.changed_file_paths)
									? state.changed_file_paths
									: [],
								pendingFixes: Array.isArray(fixes) ? fixes : [],
								planTasks: plan?.tasks ?? null,
								testPassed: !!state.test_passed_at,
								reviewDone: !!state.review_completed_at,
								disabledGates: Array.isArray(state.disabled_gates) ? state.disabled_gates : [],
							}),
						},
					],
				};
			} catch {
				return { content: [{ type: "text", text: "No active session data to hand off." }] };
			}
		}
		case "get_metrics_dashboard": {
			try {
				const metrics = readMetricsHistory(cwd);
				return { content: [{ type: "text", text: generateMetricsDashboard(metrics) }] };
			} catch {
				return { content: [{ type: "text", text: "No metrics data available yet." }] };
			}
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
						"- Independent 4-stage review (/qult:review) is required for large changes or when a plan is active.",
						"",
						"## Hook/MCP Roles",
						"- Hooks detect test pass best-effort via output parsing. If tests passed but hook didn't detect it, call record_test_pass explicitly.",
						"- After committing, session state resets (test/review cleared). This is expected — gates only apply to uncommitted changes.",
						"- MCP tools (record_test_pass, record_review) are the authoritative state management mechanism.",
						"",
						"## Ground Truth for Reviews",
						"- Before running /qult:review, call get_detector_summary to collect computational detector findings (security, imports, duplications, test quality).",
						"- Pass detector findings as context to each reviewer stage — reviewers must not contradict detector results.",
						"",
						"## Human Approval",
						"- If review.require_human_approval is enabled, call record_human_approval after the architect has reviewed and approved the changes.",
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
