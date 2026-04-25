/**
 * JSON-backed state files under `.qult/state/`.
 *
 * Three small modules colocated here to keep the file count manageable
 * (KISS). If any one grows past ~150 lines it should be split.
 *
 * - `current.json`        — test pass / review / finish timestamps
 * - `pending-fixes.json`  — detector findings (severity-tagged)
 * - `stage-scores.json`   — review + spec-evaluator scores
 *
 * NOTE (Wave 2 migration): the legacy SQLite-backed
 * `src/state/pending-fixes.ts` will be deleted in Wave 3. Until then both
 * the file-based `pending-fixes.json` API (here) and the SQLite-backed one
 * coexist; only the new MCP tool surface (Wave 2) uses this module.
 */

import { readJson, writeJson } from "./fs.ts";
import { currentJsonPath, pendingFixesJsonPath, stageScoresJsonPath } from "./paths.ts";

const SCHEMA_VERSION = 1;

// =====================================================================
// current.json
// =====================================================================

/** Project state snapshot used by `get_project_status`. */
export interface CurrentState {
	schema_version: number;
	test_passed_at: string | null;
	test_command: string | null;
	review_completed_at: string | null;
	review_score: number | null;
	finish_started_at: string | null;
	human_approval_at: string | null;
	last_active_wave: number | null;
}

const DEFAULT_CURRENT: CurrentState = {
	schema_version: SCHEMA_VERSION,
	test_passed_at: null,
	test_command: null,
	review_completed_at: null,
	review_score: null,
	finish_started_at: null,
	human_approval_at: null,
	last_active_wave: null,
};

/** Read `current.json` or return defaults. */
export function readCurrent(): CurrentState {
	const got = readJson<CurrentState>(currentJsonPath(), SCHEMA_VERSION);
	return got ?? structuredClone(DEFAULT_CURRENT);
}

/** Apply a partial patch to `current.json` and write it back. */
export function patchCurrent(patch: Partial<Omit<CurrentState, "schema_version">>): CurrentState {
	const next: CurrentState = { ...readCurrent(), ...patch, schema_version: SCHEMA_VERSION };
	writeJson(currentJsonPath(), next);
	return next;
}

// =====================================================================
// pending-fixes.json
// =====================================================================

export type FixSeverity = "critical" | "high" | "medium" | "low";

/** Detector finding entry. */
export interface PendingFix {
	id: string;
	detector: string;
	severity: FixSeverity;
	file: string;
	line: number | null;
	message: string;
	created_at: string;
}

export interface PendingFixesState {
	schema_version: number;
	fixes: PendingFix[];
}

const DEFAULT_PENDING: PendingFixesState = {
	schema_version: SCHEMA_VERSION,
	fixes: [],
};

/** Read `pending-fixes.json` or return defaults. */
export function readPendingFixes(): PendingFixesState {
	const got = readJson<PendingFixesState>(pendingFixesJsonPath(), SCHEMA_VERSION);
	return got ?? structuredClone(DEFAULT_PENDING);
}

/** Replace the entire fixes list. */
export function writePendingFixes(fixes: PendingFix[]): PendingFixesState {
	const next: PendingFixesState = { schema_version: SCHEMA_VERSION, fixes };
	writeJson(pendingFixesJsonPath(), next);
	return next;
}

/** Append one finding (no dedupe — caller decides). */
export function appendPendingFix(fix: PendingFix): PendingFixesState {
	const cur = readPendingFixes();
	cur.fixes.push(fix);
	writeJson(pendingFixesJsonPath(), cur);
	return cur;
}

/** Remove all fixes (used by `clear_pending_fixes`). */
export function clearPendingFixes(): PendingFixesState {
	return writePendingFixes([]);
}

/** True iff any fix has severity high or critical (Wave-commit gate). */
export function hasHighSeverityFix(state: PendingFixesState): boolean {
	return state.fixes.some((f) => f.severity === "high" || f.severity === "critical");
}

// =====================================================================
// stage-scores.json
// =====================================================================

/** Per-stage review scores (0-5 per dimension). */
export interface StageScore {
	scores: Record<string, number>;
	recorded_at: string;
}

/** Per-phase spec-evaluator score. */
export interface SpecEvalScore {
	total: number;
	dim_scores: Record<string, number>;
	forced_progress: boolean;
	iteration: number;
	evaluated_at: string;
}

export type SpecEvalPhase = "requirements" | "design" | "tasks";

export interface StageScoresState {
	schema_version: number;
	/** Active spec name; cleared on archive. Used for spec_eval scoping. */
	spec_name: string | null;
	review: {
		Spec: StageScore | null;
		Quality: StageScore | null;
		Security: StageScore | null;
		Adversarial: StageScore | null;
	};
	spec_eval: {
		requirements: SpecEvalScore | null;
		design: SpecEvalScore | null;
		tasks: SpecEvalScore | null;
	};
}

const DEFAULT_STAGE_SCORES: StageScoresState = {
	schema_version: SCHEMA_VERSION,
	spec_name: null,
	review: { Spec: null, Quality: null, Security: null, Adversarial: null },
	spec_eval: { requirements: null, design: null, tasks: null },
};

/** Read `stage-scores.json` or return defaults. */
export function readStageScores(): StageScoresState {
	const got = readJson<StageScoresState>(stageScoresJsonPath(), SCHEMA_VERSION);
	return got ?? structuredClone(DEFAULT_STAGE_SCORES);
}

/** Reset spec_eval block when a new spec is created (prevents stale leakage). */
export function resetSpecEval(specName: string): StageScoresState {
	const cur = readStageScores();
	const next: StageScoresState = {
		...cur,
		spec_name: specName,
		spec_eval: { requirements: null, design: null, tasks: null },
	};
	writeJson(stageScoresJsonPath(), next);
	return next;
}

/** Record a single review stage score. */
export function recordReviewStage(
	stage: keyof StageScoresState["review"],
	scores: Record<string, number>,
	now: string = new Date().toISOString(),
): StageScoresState {
	const cur = readStageScores();
	cur.review[stage] = { scores, recorded_at: now };
	writeJson(stageScoresJsonPath(), cur);
	return cur;
}

/** Record one spec-evaluator phase result. */
export function recordSpecEvalPhase(
	phase: SpecEvalPhase,
	score: Omit<SpecEvalScore, "evaluated_at"> & { evaluated_at?: string },
): StageScoresState {
	const cur = readStageScores();
	cur.spec_eval[phase] = {
		total: score.total,
		dim_scores: score.dim_scores,
		forced_progress: score.forced_progress,
		iteration: score.iteration,
		evaluated_at: score.evaluated_at ?? new Date().toISOString(),
	};
	writeJson(stageScoresJsonPath(), cur);
	return cur;
}
