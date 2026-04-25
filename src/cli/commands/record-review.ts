/**
 * `qult record-review` — persist a single 4-stage review score to
 * `.qult/state/stage-scores.json`.
 *
 * Designed for use by independent reviewer subagents (Agent tool / external
 * MCP clients that lack the `record_review` MCP method). The dashboard's
 * fs.watch picks up the resulting JSON edit and live-updates the Review
 * panel within a debounce window — no extra plumbing.
 *
 * Usage:
 *   qult record-review --stage <Spec|Quality|Security|Adversarial> \
 *     --scores '{"coverage":4,"fidelity":4,"no_drift":5,"verifiable":4}'
 *
 * Optional `--at <ISO>` overrides `recorded_at` for deterministic tests.
 */

import { recordReviewStage, type StageScoresState } from "../../state/json-state.ts";

const VALID_STAGES = ["Spec", "Quality", "Security", "Adversarial"] as const;
type Stage = (typeof VALID_STAGES)[number];

export interface RecordReviewOptions {
	stage?: string;
	scores?: string;
	at?: string;
	json?: boolean;
}

export function runRecordReview(opts: RecordReviewOptions): number {
	const { stage, scores, at, json } = opts;

	if (!stage || !VALID_STAGES.includes(stage as Stage)) {
		process.stderr.write(
			`qult record-review: --stage must be one of: ${VALID_STAGES.join(", ")}\n`,
		);
		return 1;
	}
	if (!scores) {
		process.stderr.write(
			"qult record-review: --scores is required (JSON object of dimension→0..5)\n",
		);
		return 1;
	}

	let parsed: Record<string, number>;
	try {
		const v: unknown = JSON.parse(scores);
		if (v === null || typeof v !== "object" || Array.isArray(v)) {
			throw new Error("not an object");
		}
		parsed = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 5) {
				throw new Error(`dimension "${k}" must be a number in [0, 5]`);
			}
			parsed[k] = val;
		}
		if (Object.keys(parsed).length === 0) {
			throw new Error("at least one dimension required");
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`qult record-review: bad --scores JSON: ${msg}\n`);
		return 1;
	}

	const next: StageScoresState = recordReviewStage(stage as Stage, parsed, at);

	const total = Object.values(parsed).reduce((acc, v) => acc + v, 0);
	if (json) {
		process.stdout.write(`${JSON.stringify({ stage, total, scores: parsed }, null, 2)}\n`);
	} else {
		process.stdout.write(`recorded ${stage}: ${total}/${Object.keys(parsed).length * 5}\n`);
		void next;
	}
	return 0;
}
