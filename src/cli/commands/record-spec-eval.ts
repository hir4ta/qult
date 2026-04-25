/**
 * `qult record-spec-eval` — persist a single spec-evaluator phase result
 * (requirements / design / tasks) to `.qult/state/stage-scores.json`.
 *
 * Sister command to `record-review`. Used by the spec-evaluator subagent
 * so its threshold gate writes propagate to the dashboard live without
 * relying on an MCP server.
 *
 * Usage:
 *   qult record-spec-eval --phase requirements --total 19 \
 *     --dim '{"completeness":5,"unambiguity":5,"testability":4,"feasibility":5}'
 *
 * Optional flags:
 *   --iteration N      retry count (default 1)
 *   --forced-progress  user opted to advance despite gate failure
 *   --at <ISO>         override recorded timestamp
 */

import { recordSpecEvalPhase, type SpecEvalPhase } from "../../state/json-state.ts";

const VALID_PHASES = ["requirements", "design", "tasks"] as const;

export interface RecordSpecEvalOptions {
	phase?: string;
	total?: string;
	dim?: string;
	iteration?: string;
	forcedProgress?: boolean;
	at?: string;
	json?: boolean;
}

export function runRecordSpecEval(opts: RecordSpecEvalOptions): number {
	const { phase, total, dim, iteration, forcedProgress, at, json } = opts;

	if (!phase || !VALID_PHASES.includes(phase as SpecEvalPhase)) {
		process.stderr.write(
			`qult record-spec-eval: --phase must be one of: ${VALID_PHASES.join(", ")}\n`,
		);
		return 1;
	}

	const totalNum = total === undefined ? Number.NaN : Number.parseInt(total, 10);
	if (!Number.isFinite(totalNum) || totalNum < 0 || totalNum > 20) {
		process.stderr.write("qult record-spec-eval: --total must be an integer in [0, 20]\n");
		return 1;
	}

	if (!dim) {
		process.stderr.write("qult record-spec-eval: --dim is required (JSON object of dim→0..5)\n");
		return 1;
	}

	let dimScores: Record<string, number>;
	try {
		const v: unknown = JSON.parse(dim);
		if (v === null || typeof v !== "object" || Array.isArray(v)) {
			throw new Error("not an object");
		}
		dimScores = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 5) {
				throw new Error(`dimension "${k}" must be a number in [0, 5]`);
			}
			dimScores[k] = val;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`qult record-spec-eval: bad --dim JSON: ${msg}\n`);
		return 1;
	}

	const iterNum = iteration === undefined ? 1 : Number.parseInt(iteration, 10);
	if (!Number.isFinite(iterNum) || iterNum < 1) {
		process.stderr.write("qult record-spec-eval: --iteration must be a positive integer\n");
		return 1;
	}

	recordSpecEvalPhase(phase as SpecEvalPhase, {
		total: totalNum,
		dim_scores: dimScores,
		forced_progress: forcedProgress === true,
		iteration: iterNum,
		evaluated_at: at,
	});

	if (json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					phase,
					total: totalNum,
					dim_scores: dimScores,
					iteration: iterNum,
					forced_progress: forcedProgress === true,
				},
				null,
				2,
			)}\n`,
		);
	} else {
		process.stdout.write(`recorded ${phase}: ${totalNum}/20 (iteration ${iterNum})\n`);
	}
	return 0;
}
