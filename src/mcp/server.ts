/**
 * qult MCP Server — exposes spec / state / detector / gate operations to Claude.
 *
 * State lives in `.qult/state/*.json` (JSON files with atomic rename).
 * Spec markdown lives in `.qult/specs/<name>/`. There is no SQLite, no
 * `~/.qult/`, no global config — everything is project-local.
 *
 * Uses raw JSON-RPC over stdio (newline-delimited) instead of the MCP SDK
 * to eliminate the 660KB SDK dependency and reduce coupling to SDK releases.
 */

import { createInterface } from "node:readline";
import { setProjectRoot } from "../state/paths.ts";
import {
	handleClearPendingFixes,
	handleGetCallCoverage,
	handleGetDetectorSummary,
	handleGetFileHealthScore,
	handleGetImpactAnalysis,
	handleGetPendingFixes,
} from "./tools/detector-tools.ts";
import { handleDisableGate, handleEnableGate, handleSetConfig } from "./tools/gate-tools.ts";
import {
	handleArchiveSpec,
	handleCompleteWave,
	handleGetActiveSpec,
	handleRecordSpecEvaluatorScore,
	handleUpdateTaskStatus,
} from "./tools/spec-tools.ts";
import {
	handleGetProjectStatus,
	handleRecordFinishStarted,
	handleRecordHumanApproval,
	handleRecordReview,
	handleRecordStageScores,
	handleRecordTestPass,
} from "./tools/state-tools.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "qult";
const SERVER_VERSION = "1.0.0";

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
		name: "get_project_status",
		description:
			"Returns project state as JSON: test_passed_at, review_completed_at, review_iteration, plus the active_spec block (name, current_wave, total_waves, task_summary) when a spec exists under .qult/specs/. Call before committing to verify gates.",
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
			"Set a qult config value. Allowed keys: review.score_threshold, review.max_iterations, review.required_changed_files, review.dimension_floor, review.models.{spec|quality|security|adversarial}, plan_eval.score_threshold, plan_eval.max_iterations, plan_eval.models.{generator|evaluator}, review.require_human_approval, review.low_only_passes.",
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
			"Record that tests have passed. Call after running tests successfully. Pre-commit checks read test_passed_at to verify test freshness before a commit.",
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
		name: "archive_spec",
		description:
			"Archive a completed spec by moving .qult/specs/<name>/ to .qult/specs/archive/<name>[-timestamp]/. Call from /qult:finish after the spec is complete and merged. The spec_name must match the active spec; reserved name 'archive' is rejected.",
		inputSchema: {
			type: "object",
			properties: {
				spec_name: {
					type: "string",
					description: "kebab-case spec name (e.g. 'add-oauth')",
				},
			},
			required: ["spec_name"],
		},
	},
	{
		name: "get_active_spec",
		description:
			"Return the unique active spec under .qult/specs/ (excluding archive/). Response: { name, path, has_requirements, has_design, has_tasks, total_waves, current_wave, task_summary } or null when no spec is active.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "complete_wave",
		description:
			"Finalize a Wave by writing completion timestamp and commit range to wave-NN.md. Idempotent: returns reason='already_completed' when called twice. Verifies prior Waves' Range SHAs are still reachable (rejects with reason='sha_unreachable' after rebase/reset).",
		inputSchema: {
			type: "object",
			properties: {
				wave_num: { type: "number", description: "Wave number (1-99)" },
				commit_range: {
					type: "string",
					description: "Commit range as 'startSha..endSha' (4-40 hex chars each)",
				},
			},
			required: ["wave_num", "commit_range"],
		},
	},
	{
		name: "update_task_status",
		description:
			"Update a single task's status in the active spec's tasks.md. Status: pending | in_progress | done | blocked. Returns reason='task_not_found' when task_id does not exist (NEVER silent no-op).",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string", description: "Task id like 'T1.3'" },
				status: {
					type: "string",
					description: "pending | in_progress | done | blocked",
				},
			},
			required: ["task_id", "status"],
		},
	},
	{
		name: "record_spec_evaluator_score",
		description:
			"Record a spec-evaluator score for a specific phase (requirements | design | tasks). Used during /qult:spec to gate progression through requirements → design → tasks.",
		inputSchema: {
			type: "object",
			properties: {
				phase: { type: "string", description: "requirements | design | tasks" },
				total: { type: "number", description: "Total score 0-20" },
				dim_scores: {
					type: "object",
					description: "Per-dimension scores, e.g. { completeness: 5, testability: 4 }",
				},
				forced_progress: {
					type: "boolean",
					description: "true if user force-progressed past iteration cap",
				},
				iteration: { type: "number", description: "Iteration count (1-based)" },
			},
			required: ["phase", "total", "dim_scores"],
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
	setProjectRoot(cwd);
	switch (name) {
		// Spec
		case "get_active_spec":
			return handleGetActiveSpec();
		case "complete_wave":
			return handleCompleteWave(args);
		case "update_task_status":
			return handleUpdateTaskStatus(args);
		case "archive_spec":
			return handleArchiveSpec(args);
		case "record_spec_evaluator_score":
			return handleRecordSpecEvaluatorScore(args);
		// State
		case "get_project_status":
			return handleGetProjectStatus(cwd);
		case "record_test_pass":
			return handleRecordTestPass(args);
		case "record_review":
			return handleRecordReview(args);
		case "record_stage_scores":
			return handleRecordStageScores(args);
		case "record_human_approval":
			return handleRecordHumanApproval();
		case "record_finish_started":
			return handleRecordFinishStarted();
		// Detector
		case "get_pending_fixes":
			return handleGetPendingFixes();
		case "clear_pending_fixes":
			return handleClearPendingFixes(args);
		case "get_detector_summary":
			return handleGetDetectorSummary(cwd);
		case "get_file_health_score":
			return handleGetFileHealthScore(args, cwd);
		case "get_impact_analysis":
			return handleGetImpactAnalysis(args, cwd);
		case "get_call_coverage":
			return handleGetCallCoverage(args, cwd);
		// Gate / Config
		case "disable_gate":
			return handleDisableGate(args);
		case "enable_gate":
			return handleEnableGate(args);
		case "set_config":
			return handleSetConfig(args);
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
						"qult is a quality aid for Claude. It provides Spec-Driven Development orchestration, independent reviewers, and Tier 1 detectors as MCP tools, plus workflow rules at ~/.claude/rules/qult-*.md.",
						"",
						"Run /qult:init once per project to bootstrap .qult/ and install rules.",
						"",
						"## Workflow: Spec → Wave → Review → Finish",
						'- For any non-trivial work: /qult:spec <name> "<description>" — runs requirements → clarify → design → tasks with a spec-evaluator gate per phase. Never use EnterPlanMode for implementation work.',
						"- Implement Wave by Wave: /qult:wave-start (records HEAD) → /qult:wip 'message' for intermediate WIP commits (auto-prefixes [wave-NN]) → /qult:wave-complete to test + run detectors + commit + record Range.",
						"- At spec completion: /qult:review (4-stage independent review). Per-Wave automatic review is intentionally not run.",
						"- Closing the spec: /qult:finish — archives .qult/specs/<name>/ to .qult/specs/archive/<name>/ and offers merge / PR / hold / discard.",
						"- Trivial changes (≤5 files, typo, lockfile bump): commit normally. /qult:status will surface a hint at 5+ files.",
						"",
						"## Spec / Wave MCP tools",
						"- get_active_spec — current spec phase, current Wave, task summary.",
						"- update_task_status — flip a task in tasks.md. Returns reason='task_not_found' on bad id (NEVER silent no-op).",
						"- complete_wave — idempotent finalization; returns reason='already_completed' on retry, reason='sha_unreachable' when prior Wave Range SHAs were rebased away.",
						"- record_spec_evaluator_score — record per-phase evaluator score (auto-resets spec_eval block on new spec).",
						"- archive_spec — called by /qult:finish.",
						"",
						"## State recording (authoritative)",
						"- After running tests successfully: call record_test_pass with the test command.",
						"- At the end of /qult:review: record_review with the aggregate score.",
						"- During /qult:finish: record_finish_started.",
						"- Before committing: call get_project_status to verify active_spec / test_passed_at / review_completed_at.",
						"",
						"## Tier 1 detectors (reviewer ground truth)",
						"- Before /qult:review: call get_detector_summary to collect detector findings (security, dep-vuln, hallucinated-package, test-quality, export-check).",
						"- Reviewers must NOT contradict detector findings — cross-validation will flag 'No issues found' when detectors reported problems.",
						"- Severity ∈ {high, critical} blocks /qult:wave-complete until cleared.",
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
