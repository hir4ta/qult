/**
 * State category MCP tool handlers (6 tools):
 * get_project_status, record_test_pass, record_review,
 * record_stage_scores, record_human_approval, record_finish_started.
 *
 * Each handler is pure (args in → ToolResult out) and reads / writes
 * `.qult/state/*.json` via the state modules.
 */

import { loadConfig } from "../../config.ts";
import { appendAuditLog } from "../../state/audit-log.ts";
import { patchCurrent, readCurrent, recordReviewStage } from "../../state/json-state.ts";
import { errorResult, jsonResult, type ToolResult, textResult } from "./shared.ts";
import { handleGetActiveSpec } from "./spec-tools.ts";

export function handleGetProjectStatus(cwd: string): ToolResult {
	const cur = readCurrent();
	const config = loadConfig();
	let activeSpecBlock: unknown = null;
	let activeSpecError: string | null = null;
	try {
		const r = handleGetActiveSpec();
		if (r.isError) {
			activeSpecError = r.content[0]?.text ?? "active spec error";
		} else {
			activeSpecBlock = JSON.parse(r.content[0]?.text ?? "null");
		}
	} catch (err) {
		activeSpecError = (err as Error).message;
	}
	return jsonResult({
		path: cwd,
		test_passed_at: cur.test_passed_at,
		test_command: cur.test_command,
		review_completed_at: cur.review_completed_at,
		review_score: cur.review_score,
		finish_started_at: cur.finish_started_at,
		human_approval_at: cur.human_approval_at,
		review_models: config.review.models,
		review_config: config.review,
		active_spec: activeSpecBlock,
		active_spec_error: activeSpecError,
	});
}

export function handleRecordTestPass(args: Record<string, unknown> | undefined): ToolResult {
	const cmd = typeof args?.command === "string" ? args.command : null;
	if (!cmd) return errorResult("Missing command parameter.");
	patchCurrent({ test_passed_at: new Date().toISOString(), test_command: cmd });
	return textResult(`Test pass recorded: ${cmd}`);
}

export function handleRecordReview(args: Record<string, unknown> | undefined): ToolResult {
	const score = typeof args?.aggregate_score === "number" ? args.aggregate_score : null;
	patchCurrent({
		review_completed_at: new Date().toISOString(),
		review_score: score,
	});
	return textResult(score !== null ? `Review recorded (aggregate: ${score}).` : "Review recorded.");
}

const VALID_STAGES = ["Spec", "Quality", "Security", "Adversarial"] as const;
type ValidStage = (typeof VALID_STAGES)[number];

export function handleRecordStageScores(args: Record<string, unknown> | undefined): ToolResult {
	const stage = typeof args?.stage === "string" ? args.stage : null;
	const scores = args?.scores;
	if (!stage || !scores || typeof scores !== "object") {
		return errorResult("Missing stage or scores parameter.");
	}
	if (!VALID_STAGES.includes(stage as ValidStage)) {
		return errorResult(`Invalid stage. Must be: ${VALID_STAGES.join(", ")}`);
	}
	const dimRecord: Record<string, number> = {};
	for (const [dim, val] of Object.entries(scores as Record<string, unknown>)) {
		if (typeof val === "number") dimRecord[dim] = val;
	}
	recordReviewStage(stage as ValidStage, dimRecord);
	return textResult(`Stage scores recorded: ${stage} = ${JSON.stringify(scores)}`);
}

export function handleRecordHumanApproval(): ToolResult {
	const cur = readCurrent();
	if (!cur.review_completed_at) {
		return errorResult("Cannot record approval: no review completed. Run /qult:review first.");
	}
	if (!cur.test_passed_at) {
		return errorResult(
			"Cannot record approval: no test pass recorded. Run tests + record_test_pass first.",
		);
	}
	patchCurrent({ human_approval_at: new Date().toISOString() });
	appendAuditLog({
		action: "record_human_approval",
		reason: "Architect approved changes",
		timestamp: new Date().toISOString(),
	});
	return textResult("Human approval recorded.");
}

export function handleRecordFinishStarted(): ToolResult {
	patchCurrent({ finish_started_at: new Date().toISOString() });
	return textResult("Finish started recorded.");
}
