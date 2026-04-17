/**
 * qult MCP Server — exposes quality gate state to Claude via tools.
 *
 * Architecture: hooks write state to SQLite DB (~/.qult/qult.db).
 * This server lets Claude query/modify that state via MCP tools.
 * Runs as stdio transport, spawned by Claude Code plugin system.
 *
 * Uses raw JSON-RPC over stdio (newline-delimited) instead of the MCP SDK
 * to eliminate the 660KB SDK dependency and reduce coupling to SDK releases.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, resetConfigCache } from "./config.ts";
import { computeFileHealthScore } from "./hooks/detectors/health-score.ts";
import { findImporters } from "./hooks/detectors/import-graph.ts";
import { validateTestCoversImpl } from "./hooks/detectors/spec-trace-check.ts";
import { appendAuditLog } from "./state/audit-log.ts";
import { getDb, getProjectId, setProjectPath } from "./state/db.ts";
import { archivePlanFile, resetPlanCache } from "./state/plan-status.ts";
import type { PendingFix } from "./types.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "qult";
const SERVER_VERSION = "1.0.0";

/** Resolve the current session for MCP operations. Uses latest session for this project. */

// ── Gate name validation (for disable_gate / enable_gate on detectors) ─

const VALID_DETECTOR_GATES = [
	"review",
	"security-check",
	"semgrep-required",
	"test-quality-check",
	"dep-vuln-check",
	"hallucinated-package-check",
];

function isValidGateName(name: string): boolean {
	return VALID_DETECTOR_GATES.includes(name);
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
			"Set a qult config value. Allowed keys: review.score_threshold, review.max_iterations, review.required_changed_files, review.dimension_floor, review.models.{spec|quality|security|adversarial}, plan_eval.score_threshold, plan_eval.max_iterations, plan_eval.models.{generator|evaluator}, review.require_human_approval.",
		inputSchema: {
			type: "object",
			properties: {
				key: { type: "string", description: "Config key (e.g. 'review.score_threshold')" },
				value: { type: "number", description: "Numeric value to set" },
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
			"Returns a consolidated summary of all computational detector findings from the current session. Includes escalation counters and pending fixes grouped by gate. Call before /qult:review to collect ground truth for reviewers.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_file_health_score",
		description:
			"Compute a 0-10 health score for a file by aggregating Tier 1 detector findings (security, dead-imports, export-breaking, test-quality). 10 = no issues, 0 = critical. Returns score and per-detector breakdown.",
		inputSchema: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Absolute path to the file to score",
				},
			},
			required: ["file_path"],
		},
	},
	{
		name: "record_human_approval",
		description:
			"Record that the architect has reviewed and approved the changes. Required when review.require_human_approval is enabled.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "record_stage_scores",
		description:
			"Record review scores for a specific stage (Spec, Quality, Security, or Adversarial). Used for 4-stage aggregate score tracking (/40).",
		inputSchema: {
			type: "object",
			properties: {
				stage: {
					type: "string",
					description: "Stage name: 'Spec', 'Quality', 'Security', or 'Adversarial'",
				},
				scores: {
					type: "object",
					description: "Dimension scores (e.g. {completeness: 5, accuracy: 4})",
				},
			},
			required: ["stage", "scores"],
		},
	},
	{
		name: "record_finish_started",
		description:
			"Record that /qult:finish has been started. Call at the beginning of /qult:finish skill. Required for the commit gate to allow commits when a plan is active.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "archive_plan",
		description:
			"Archive a completed plan file to prevent detection in future sessions. Moves the plan to an archive/ subdirectory. Call after /qult:finish completes successfully.",
		inputSchema: {
			type: "object",
			properties: {
				plan_path: {
					type: "string",
					description: "Absolute path to the plan file to archive",
				},
			},
			required: ["plan_path"],
		},
	},
	{
		name: "get_impact_analysis",
		description:
			"Analyze the impact of changes to a file. Returns a list of consumer files (importers) that may be affected, using the import graph.",
		inputSchema: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description: "Absolute path to the changed file",
				},
			},
			required: ["file"],
		},
	},
	{
		name: "get_call_coverage",
		description:
			"Check whether a test file covers (imports from) an implementation file. Uses import graph to verify the test→impl dependency path exists.",
		inputSchema: {
			type: "object",
			properties: {
				test_file: {
					type: "string",
					description: "Absolute path to the test file",
				},
				impl_file: {
					type: "string",
					description: "Absolute path to the implementation file",
				},
			},
			required: ["test_file", "impl_file"],
		},
	},
];

function handleTool(name: string, cwd: string, args?: Record<string, unknown>): ToolResult {
	setProjectPath(cwd);
	const db = getDb();
	const pid = getProjectId();

	switch (name) {
		case "get_pending_fixes": {
			const rows = db
				.prepare("SELECT file, gate, errors FROM pending_fixes WHERE project_id = ?")
				.all(pid) as { file: string; gate: string; errors: string }[];
			if (rows.length === 0) {
				return { content: [{ type: "text", text: "No pending fixes." }] };
			}
			const fixes: PendingFix[] = rows.map((r) => ({
				file: r.file,
				gate: r.gate,
				errors: JSON.parse(r.errors) as string[],
			}));
			const lines: string[] = [`${fixes.length} pending fix(es):\n`];
			for (const fix of fixes) {
				lines.push(`[${fix.gate}] ${fix.file}`);
				for (const err of fix.errors) lines.push(`  ${err}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }] };
		}
		case "get_session_status": {
			const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
			if (!row) {
				return {
					isError: true,
					content: [{ type: "text", text: "No session state. Run /qult:init to set up." }],
				};
			}
			// Include review model config so skills can read it
			const config = loadConfig();
			const enriched = {
				...(row as Record<string, unknown>),
				review_models: config.review.models,
			};
			return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
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
						{ type: "text", text: "Missing or insufficient reason (min 10 chars, min 5 unique)." },
					],
				};
			}
			if (!isValidGateName(gateName)) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Unknown gate '${gateName}'. Valid: ${VALID_DETECTOR_GATES.join(", ")}`,
						},
					],
				};
			}
			const disabled = db
				.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?")
				.all(pid) as { gate_name: string }[];
			if (!disabled.some((d) => d.gate_name === gateName) && disabled.length >= 2) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Maximum 2 gates disabled. Currently: ${disabled.map((d) => d.gate_name).join(", ")}`,
						},
					],
				};
			}
			db.prepare(
				"INSERT OR REPLACE INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)",
			).run(pid, gateName, reason);
			appendAuditLog({
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
			db.prepare("DELETE FROM disabled_gates WHERE project_id = ? AND gate_name = ?").run(
				pid,
				gateName,
			);
			return { content: [{ type: "text", text: `Gate '${gateName}' re-enabled.` }] };
		}
		case "set_config": {
			const key = typeof args?.key === "string" ? args.key : null;
			const rawValue = args?.value;
			const value =
				typeof rawValue === "number"
					? rawValue
					: typeof rawValue === "string"
						? rawValue
						: typeof rawValue === "boolean"
							? rawValue
							: null;
			if (!key || value === null) {
				return {
					isError: true,
					content: [{ type: "text", text: "Missing key or value parameter." }],
				};
			}
			const ALLOWED_NUMBER_KEYS = [
				"review.score_threshold",
				"review.max_iterations",
				"review.required_changed_files",
				"review.dimension_floor",
				"plan_eval.score_threshold",
				"plan_eval.max_iterations",
			];
			const ALLOWED_MODEL_KEYS = [
				"review.models.spec",
				"review.models.quality",
				"review.models.security",
				"review.models.adversarial",
				"plan_eval.models.generator",
				"plan_eval.models.evaluator",
			];
			const ALLOWED_BOOLEAN_KEYS = ["review.require_human_approval"];
			const ALL_ALLOWED = [...ALLOWED_NUMBER_KEYS, ...ALLOWED_MODEL_KEYS, ...ALLOWED_BOOLEAN_KEYS];
			if (!ALL_ALLOWED.includes(key)) {
				return {
					isError: true,
					content: [{ type: "text", text: `Invalid key. Allowed: ${ALL_ALLOWED.join(", ")}` }],
				};
			}
			if (ALLOWED_NUMBER_KEYS.includes(key) && typeof value !== "number") {
				return {
					isError: true,
					content: [{ type: "text", text: `Key '${key}' requires a number value.` }],
				};
			}
			if (ALLOWED_MODEL_KEYS.includes(key)) {
				const VALID_MODELS = ["sonnet", "opus", "haiku", "inherit"];
				if (typeof value !== "string" || !VALID_MODELS.includes(value)) {
					return {
						isError: true,
						content: [{ type: "text", text: `Model must be one of: ${VALID_MODELS.join(", ")}` }],
					};
				}
			}
			if (ALLOWED_BOOLEAN_KEYS.includes(key) && typeof value !== "boolean") {
				return {
					isError: true,
					content: [{ type: "text", text: `Key '${key}' requires a boolean value.` }],
				};
			}
			if (
				key === "review.dimension_floor" &&
				typeof value === "number" &&
				(value < 1 || value > 5)
			) {
				return { isError: true, content: [{ type: "text", text: "dimension_floor must be 1-5." }] };
			}
			const projectId = getProjectId();
			db.prepare(
				"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
			).run(projectId, key, JSON.stringify(value));
			resetConfigCache();
			return { content: [{ type: "text", text: `Config set: ${key} = ${value}` }] };
		}
		case "clear_pending_fixes": {
			const reason = typeof args?.reason === "string" ? args.reason : null;
			if (!reason || reason.length < 10 || new Set(reason).size < 5) {
				return {
					isError: true,
					content: [
						{ type: "text", text: "Missing or insufficient reason (min 10 chars, min 5 unique)." },
					],
				};
			}
			db.prepare("DELETE FROM pending_fixes WHERE project_id = ?").run(pid);
			appendAuditLog({
				action: "clear_pending_fixes",
				reason,
				timestamp: new Date().toISOString(),
			});
			return { content: [{ type: "text", text: "All pending fixes cleared." }] };
		}
		case "get_detector_summary": {
			const session = db.prepare("SELECT * FROM projects WHERE id = ?").get(pid) as Record<
				string,
				unknown
			> | null;
			const fixes = db
				.prepare("SELECT file, gate, errors FROM pending_fixes WHERE project_id = ?")
				.all(pid) as { file: string; gate: string; errors: string }[];

			const lines: string[] = [];
			if (session) {
				const counters = [
					"security_warning_count",
					"dead_import_warning_count",
					"drift_warning_count",
					"test_quality_warning_count",
					"duplication_warning_count",
					"semantic_warning_count",
				] as const;
				for (const key of counters) {
					const val = typeof session[key] === "number" ? (session[key] as number) : 0;
					if (val > 0) lines.push(`${key}: ${val}`);
				}
			}

			if (fixes.length > 0) {
				const byGate: Record<string, { file: string; errors: string[] }[]> = {};
				for (const fix of fixes) {
					const g = fix.gate ?? "unknown";
					if (!byGate[g]) byGate[g] = [];
					byGate[g].push({ file: fix.file, errors: JSON.parse(fix.errors) });
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
		case "get_file_health_score": {
			const filePath = typeof args?.file_path === "string" ? args.file_path : "";
			if (!filePath) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ score: 10, breakdown: {}, error: "file_path required" }),
						},
					],
				};
			}
			const resolvedHealth = resolve(filePath);
			if (!resolvedHealth.startsWith(`${cwd}/`)) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								score: 10,
								breakdown: {},
								error: "file_path must be within project directory",
							}),
						},
					],
				};
			}
			try {
				const result = computeFileHealthScore(resolvedHealth);
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			} catch {
				return { content: [{ type: "text", text: JSON.stringify({ score: 10, breakdown: {} }) }] };
			}
		}
		case "record_review": {
			db.prepare("UPDATE projects SET review_completed_at = ? WHERE id = ?").run(
				new Date().toISOString(),
				pid,
			);
			const score = typeof args?.aggregate_score === "number" ? args.aggregate_score : null;
			const msg = score !== null ? `Review recorded (aggregate: ${score}).` : "Review recorded.";
			return { content: [{ type: "text", text: msg }] };
		}
		case "record_test_pass": {
			const cmd = typeof args?.command === "string" ? args.command : null;
			if (!cmd) {
				return { isError: true, content: [{ type: "text", text: "Missing command parameter." }] };
			}
			db.prepare("UPDATE projects SET test_passed_at = ?, test_command = ? WHERE id = ?").run(
				new Date().toISOString(),
				cmd,
				pid,
			);
			return { content: [{ type: "text", text: `Test pass recorded: ${cmd}` }] };
		}
		case "record_human_approval": {
			const session = db
				.prepare("SELECT review_completed_at FROM projects WHERE id = ?")
				.get(pid) as {
				review_completed_at: string | null;
			} | null;
			if (!session?.review_completed_at) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Cannot record approval: no review completed. Run /qult:review first.",
						},
					],
				};
			}
			db.prepare("UPDATE projects SET human_review_approved_at = ? WHERE id = ?").run(
				new Date().toISOString(),
				pid,
			);
			appendAuditLog({
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
					content: [{ type: "text", text: `Invalid stage. Must be: ${validStages.join(", ")}` }],
				};
			}
			const insertScore = db.prepare(
				"INSERT OR REPLACE INTO review_stage_scores (project_id, stage, dimension, score) VALUES (?, ?, ?, ?)",
			);
			for (const [dim, score] of Object.entries(scores as Record<string, number>)) {
				insertScore.run(pid, stage, dim, score);
			}
			return {
				content: [
					{ type: "text", text: `Stage scores recorded: ${stage} = ${JSON.stringify(scores)}` },
				],
			};
		}
		case "record_finish_started": {
			// Write directly to DB (not via writeState cache) so hook processes can read it immediately
			db.prepare(
				"INSERT OR REPLACE INTO ran_gates (project_id, gate_name, ran_at) VALUES (?, ?, ?)",
			).run(pid, "__finish_started__", new Date().toISOString());
			return { content: [{ type: "text", text: "Finish started recorded." }] };
		}
		case "archive_plan": {
			const planPath = typeof args?.plan_path === "string" ? args.plan_path : null;
			if (!planPath) {
				return { content: [{ type: "text", text: "Error: plan_path is required." }] };
			}
			// Path traversal guard: plan_path must resolve under .claude/plans/
			const resolvedPath = resolve(cwd, planPath);
			const allowedBases = [
				resolve(join(cwd, ".claude", "plans")),
				resolve(join(homedir(), ".claude", "plans")),
			];
			// Support CLAUDE_PLANS_DIR env var (custom plan directory)
			const envPlansDir = process.env.CLAUDE_PLANS_DIR;
			if (envPlansDir) allowedBases.push(resolve(envPlansDir));
			const isAllowed =
				allowedBases.some((base) => resolvedPath.startsWith(`${base}/`)) &&
				resolvedPath.endsWith(".md");
			if (!isAllowed) {
				return {
					content: [
						{ type: "text", text: "Error: plan_path must be a .md file under .claude/plans/" },
					],
				};
			}
			// Check if file exists before archiving (distinguish no-op from success)
			if (!existsSync(resolvedPath)) {
				return {
					content: [{ type: "text", text: "Plan not found (already archived or path incorrect)." }],
				};
			}
			archivePlanFile(resolvedPath);
			resetPlanCache();
			return { content: [{ type: "text", text: "Plan archived." }] };
		}
		case "get_impact_analysis": {
			const file = typeof args?.file === "string" ? args.file : "";
			if (!file) {
				return {
					isError: true,
					content: [{ type: "text", text: "Missing file parameter." }],
				};
			}
			try {
				const config = loadConfig();
				const consumers = findImporters(file, cwd, config.gates.import_graph_depth);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ file, consumers, count: consumers.length }),
						},
					],
				};
			} catch {
				return {
					content: [{ type: "text", text: JSON.stringify({ file, consumers: [], count: 0 }) }],
				};
			}
		}
		case "get_call_coverage": {
			const testFile = typeof args?.test_file === "string" ? args.test_file : "";
			const implFile = typeof args?.impl_file === "string" ? args.impl_file : "";
			if (!testFile || !implFile) {
				return {
					isError: true,
					content: [{ type: "text", text: "Missing test_file or impl_file parameter." }],
				};
			}
			try {
				const covered = validateTestCoversImpl(testFile, "", implFile, cwd);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ test_file: testFile, impl_file: implFile, covered }),
						},
					],
				};
			} catch {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ test_file: testFile, impl_file: implFile, covered: false }),
						},
					],
				};
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

function handleRequest(parsed: JsonRpcRequest, cwd: string): JsonRpcResponse | null {
	const id = parsed.id;
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
						"qult is a quality aid for Claude. It provides workflow rules (at ~/.claude/rules/qult-*.md), independent reviewers, and Tier 1 detectors as MCP tools.",
						"",
						"If gates are not configured, run /qult:init.",
						"",
						"## Workflow",
						"- Plan → Implement → Review → Finish",
						"- For any non-trivial work: use /qult:plan-generator (do NOT use EnterPlanMode directly; it bypasses plan-evaluator).",
						"- Track each plan task with TaskCreate; mark [done] as you complete them.",
						"- For changes spanning 5+ files or any commit with an active plan: run /qult:review (4-stage independent review).",
						"- After implementation completes: use /qult:finish for the structured completion checklist.",
						"",
						"## State recording (authoritative)",
						"- After running tests successfully: call record_test_pass with the test command.",
						"- At the end of /qult:review: record_review with the aggregate score.",
						"- During /qult:finish: record_finish_started.",
						"- Before committing: call get_session_status to verify test/review gates.",
						"",
						"## Tier 1 detectors (reviewer ground truth)",
						"- Before /qult:review: call get_detector_summary to collect detector findings (security, dep-vuln, hallucinated-package, test-quality, export-check).",
						"- Reviewers must NOT contradict detector findings — cross-validation will flag 'No issues found' when detectors reported problems.",
						"",
						"## Human approval",
						"- If review.require_human_approval is enabled, call record_human_approval after the architect has reviewed and approved.",
						"",
						"## Impact analysis",
						"- After modifying types or exported interfaces: call get_impact_analysis to find affected consumer files.",
						"- Use get_call_coverage to verify a test file imports and exercises the implementation under test.",
					].join("\n"),
				},
			};

		case "tools/list":
			return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } };

		case "tools/call": {
			const params = parsed.params as Record<string, unknown>;
			const toolName = params?.name;
			if (typeof toolName !== "string") {
				return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } };
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

export { handleRequest, handleTool, TOOL_DEFS };
