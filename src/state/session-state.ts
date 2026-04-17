import { loadConfig } from "../config.ts";
import { computeReviewTier } from "../review-tier.ts";
import { getDb, getProjectId } from "./db.ts";
import { getActivePlan } from "./plan-status.ts";

/**
 * Per-session quality state.
 *
 * Fields are grouped by domain. Each group is managed by dedicated
 * helper functions below — avoid mutating fields directly.
 */
export interface SessionState {
	// ── Commit lifecycle ─────────────────────────────────────
	last_commit_at: string;

	// ── Test gate ────────────────────────────────────────────
	test_passed_at: string | null;
	test_command: string | null;

	// ── Review gate ──────────────────────────────────────────
	review_completed_at: string | null;
	review_iteration: number;
	review_score_history: number[];
	review_stage_scores: Record<string, Record<string, number>>;

	// ── Plan evaluation ──────────────────────────────────────
	plan_eval_iteration: number;
	plan_eval_score_history: number[];
	plan_selfcheck_blocked_at: string | null;

	// ── Gate batch tracking ──────────────────────────────────
	ran_gates: Record<string, { ran_at: string }>;

	// ── File tracking ────────────────────────────────────────
	changed_file_paths: string[];

	// ── Gate override ────────────────────────────────────────
	disabled_gates: string[];

	// ── TDD RED verification ─────────────────────────────────
	task_verify_results: Record<string, { passed: boolean; ran_at: string }>;

	// ── Gate failure escalation ──────────────────────────────
	gate_failure_counts: Record<string, number>;

	// ── Quality escalation counters ──────────────────────────
	security_warning_count: number;
	test_quality_warning_count: number;
	drift_warning_count: number;
	dead_import_warning_count: number;
	duplication_warning_count: number;
	semantic_warning_count: number;
	human_review_approved_at: string | null;
}

// Process-scoped cache: read once from DB, flush once at end
let _cache: SessionState | null = null;
let _dirty = false;

function defaultState(): SessionState {
	return {
		last_commit_at: new Date().toISOString(),
		test_passed_at: null,
		test_command: null,
		review_completed_at: null,
		ran_gates: {},
		changed_file_paths: [],
		review_iteration: 0,
		review_score_history: [],
		review_stage_scores: {},
		plan_eval_iteration: 0,
		plan_eval_score_history: [],
		plan_selfcheck_blocked_at: null,
		disabled_gates: [],
		task_verify_results: {},
		gate_failure_counts: {},
		security_warning_count: 0,
		test_quality_warning_count: 0,
		drift_warning_count: 0,
		dead_import_warning_count: 0,
		duplication_warning_count: 0,
		semantic_warning_count: 0,
		human_review_approved_at: null,
	};
}

/** Read session state from DB. Returns defaults on error (fail-open). */
export function readSessionState(): SessionState {
	if (_cache) return _cache;
	try {
		const db = getDb();
		const pid = getProjectId();

		// Read project state
		const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(pid) as Record<
			string,
			unknown
		> | null;
		if (!row) {
			_cache = defaultState();
			return _cache;
		}

		const state = defaultState();
		state.last_commit_at = (row.last_commit_at as string) ?? state.last_commit_at;
		state.test_passed_at = (row.test_passed_at as string | null) ?? null;
		state.test_command = (row.test_command as string | null) ?? null;
		state.review_completed_at = (row.review_completed_at as string | null) ?? null;
		state.review_iteration = (row.review_iteration as number) ?? 0;
		state.plan_eval_iteration = (row.plan_eval_iteration as number) ?? 0;
		state.plan_selfcheck_blocked_at = (row.plan_selfcheck_blocked_at as string | null) ?? null;
		state.human_review_approved_at = (row.human_review_approved_at as string | null) ?? null;
		state.security_warning_count = (row.security_warning_count as number) ?? 0;
		state.test_quality_warning_count = (row.test_quality_warning_count as number) ?? 0;
		state.drift_warning_count = (row.drift_warning_count as number) ?? 0;
		state.dead_import_warning_count = (row.dead_import_warning_count as number) ?? 0;
		state.duplication_warning_count = (row.duplication_warning_count as number) ?? 0;
		state.semantic_warning_count = (row.semantic_warning_count as number) ?? 0;

		// Read child tables
		const changedFiles = db
			.prepare("SELECT file_path FROM changed_files WHERE project_id = ?")
			.all(pid) as { file_path: string }[];
		state.changed_file_paths = changedFiles.map((r) => r.file_path);

		const disabledGates = db
			.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?")
			.all(pid) as { gate_name: string }[];
		state.disabled_gates = disabledGates.map((r) => r.gate_name);

		const ranGates = db
			.prepare("SELECT gate_name, ran_at FROM ran_gates WHERE project_id = ?")
			.all(pid) as { gate_name: string; ran_at: string }[];
		for (const g of ranGates) {
			state.ran_gates[g.gate_name] = { ran_at: g.ran_at };
		}

		const taskResults = db
			.prepare("SELECT task_key, passed, ran_at FROM task_verify_results WHERE project_id = ?")
			.all(pid) as { task_key: string; passed: number; ran_at: string }[];
		for (const t of taskResults) {
			state.task_verify_results[t.task_key] = { passed: !!t.passed, ran_at: t.ran_at };
		}

		const gateFailures = db
			.prepare("SELECT file, gate, count FROM gate_failure_counts WHERE project_id = ?")
			.all(pid) as { file: string; gate: string; count: number }[];
		for (const f of gateFailures) {
			state.gate_failure_counts[`${f.file}:${f.gate}`] = f.count;
		}

		const reviewScores = db
			.prepare("SELECT aggregate_score FROM review_scores WHERE project_id = ? ORDER BY iteration")
			.all(pid) as { aggregate_score: number }[];
		state.review_score_history = reviewScores.map((r) => r.aggregate_score);

		const stageScores = db
			.prepare("SELECT stage, dimension, score FROM review_stage_scores WHERE project_id = ?")
			.all(pid) as { stage: string; dimension: string; score: number }[];
		for (const s of stageScores) {
			if (!state.review_stage_scores[s.stage]) state.review_stage_scores[s.stage] = {};
			state.review_stage_scores[s.stage]![s.dimension] = s.score;
		}

		const planScores = db
			.prepare(
				"SELECT aggregate_score FROM plan_eval_scores WHERE project_id = ? ORDER BY iteration",
			)
			.all(pid) as { aggregate_score: number }[];
		state.plan_eval_score_history = planScores.map((r) => r.aggregate_score);

		_cache = state;
		return state;
	} catch {
		_cache = defaultState();
		return _cache;
	}
}

function writeState(state: SessionState): void {
	_cache = state;
	_dirty = true;
}

/** Flush cached state to DB if dirty. */
export function flush(): void {
	if (!_dirty || !_cache) return;
	try {
		const db = getDb();
		const pid = getProjectId();
		const state = _cache;

		// Use a transaction for atomicity
		db.exec("BEGIN");
		try {
			// Update project state
			db.prepare(`UPDATE projects SET
				last_commit_at = ?,
				test_passed_at = ?,
				test_command = ?,
				review_completed_at = ?,
				review_iteration = ?,
				plan_eval_iteration = ?,
				plan_selfcheck_blocked_at = ?,
				human_review_approved_at = ?,
				security_warning_count = ?,
				test_quality_warning_count = ?,
				drift_warning_count = ?,
				dead_import_warning_count = ?,
				duplication_warning_count = ?,
				semantic_warning_count = ?
				WHERE id = ?`).run(
				state.last_commit_at,
				state.test_passed_at,
				state.test_command,
				state.review_completed_at,
				state.review_iteration,
				state.plan_eval_iteration,
				state.plan_selfcheck_blocked_at,
				state.human_review_approved_at,
				state.security_warning_count,
				state.test_quality_warning_count,
				state.drift_warning_count,
				state.dead_import_warning_count,
				state.duplication_warning_count,
				state.semantic_warning_count,
				pid,
			);

			// Sync changed_files
			db.prepare("DELETE FROM changed_files WHERE project_id = ?").run(pid);
			const insertFile = db.prepare(
				"INSERT INTO changed_files (project_id, file_path) VALUES (?, ?)",
			);
			for (const fp of state.changed_file_paths) {
				insertFile.run(pid, fp);
			}

			// Sync disabled_gates: merge (INSERT OR IGNORE) to avoid clobbering
			// concurrent MCP disable_gate writes that bypassed the cache.
			// Re-enable (enableGate) already removes from cache so stale rows
			// are cleaned up by the DELETE of rows not in the in-memory set.
			const inMemoryGates = new Set(state.disabled_gates);
			const dbGates = db
				.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?")
				.all(pid) as { gate_name: string }[];
			// Remove gates that were re-enabled in-process but exist in DB
			for (const { gate_name } of dbGates) {
				if (!inMemoryGates.has(gate_name)) {
					db.prepare("DELETE FROM disabled_gates WHERE project_id = ? AND gate_name = ?").run(
						pid,
						gate_name,
					);
				}
			}
			// Insert gates that are in-memory but not yet in DB
			const insertGate = db.prepare(
				"INSERT OR IGNORE INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)",
			);
			for (const g of state.disabled_gates) {
				insertGate.run(pid, g, "");
			}

			// Sync ran_gates
			db.prepare("DELETE FROM ran_gates WHERE project_id = ?").run(pid);
			const insertRan = db.prepare(
				"INSERT INTO ran_gates (project_id, gate_name, ran_at) VALUES (?, ?, ?)",
			);
			for (const [name, entry] of Object.entries(state.ran_gates)) {
				insertRan.run(pid, name, entry.ran_at);
			}

			// Sync task_verify_results
			db.prepare("DELETE FROM task_verify_results WHERE project_id = ?").run(pid);
			const insertTask = db.prepare(
				"INSERT INTO task_verify_results (project_id, task_key, passed, ran_at) VALUES (?, ?, ?, ?)",
			);
			for (const [key, result] of Object.entries(state.task_verify_results)) {
				insertTask.run(pid, key, result.passed ? 1 : 0, result.ran_at);
			}

			// Sync gate_failure_counts
			db.prepare("DELETE FROM gate_failure_counts WHERE project_id = ?").run(pid);
			const insertFailure = db.prepare(
				"INSERT INTO gate_failure_counts (project_id, file, gate, count) VALUES (?, ?, ?, ?)",
			);
			for (const [key, count] of Object.entries(state.gate_failure_counts)) {
				const lastColon = key.lastIndexOf(":");
				if (lastColon === -1) continue;
				const file = key.slice(0, lastColon);
				const gate = key.slice(lastColon + 1);
				insertFailure.run(pid, file, gate, count);
			}

			// Sync review_scores
			db.prepare("DELETE FROM review_scores WHERE project_id = ?").run(pid);
			const insertReview = db.prepare(
				"INSERT INTO review_scores (project_id, iteration, aggregate_score) VALUES (?, ?, ?)",
			);
			for (let i = 0; i < state.review_score_history.length; i++) {
				insertReview.run(pid, i + 1, state.review_score_history[i]!);
			}

			// Sync review_stage_scores
			db.prepare("DELETE FROM review_stage_scores WHERE project_id = ?").run(pid);
			const insertStage = db.prepare(
				"INSERT INTO review_stage_scores (project_id, stage, dimension, score) VALUES (?, ?, ?, ?)",
			);
			for (const [stage, dims] of Object.entries(state.review_stage_scores)) {
				for (const [dim, score] of Object.entries(dims)) {
					insertStage.run(pid, stage, dim, score);
				}
			}

			// Sync plan_eval_scores
			db.prepare("DELETE FROM plan_eval_scores WHERE project_id = ?").run(pid);
			const insertPlan = db.prepare(
				"INSERT INTO plan_eval_scores (project_id, iteration, aggregate_score) VALUES (?, ?, ?)",
			);
			for (let i = 0; i < state.plan_eval_score_history.length; i++) {
				insertPlan.run(pid, i + 1, state.plan_eval_score_history[i]!);
			}

			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
		_dirty = false;
	} catch (e) {
		if (e instanceof Error) process.stderr.write(`[qult] state write error: ${e.message}\n`);
	}
}

/** Reset cache (for tests). */
export function resetCache(): void {
	_cache = null;
	_dirty = false;
}

// ── File tracking ───────────────────────────────────────────

export function recordChangedFile(filePath: string): void {
	const state = readSessionState();
	if (!state.changed_file_paths) state.changed_file_paths = [];
	if (!state.changed_file_paths.includes(filePath)) {
		state.changed_file_paths.push(filePath);
	}
	writeState(state);
}

export function isReviewRequired(): boolean {
	const state = readSessionState();
	const changedCount = state.changed_file_paths?.length ?? 0;
	const hasPlan = getActivePlan() !== null;
	const tier = computeReviewTier(changedCount, hasPlan, loadConfig(), state.changed_file_paths);
	return tier === "standard" || tier === "deep";
}

// ── Test gate ───────────────────────────────────────────────

export function readLastTestPass(): {
	passed_at: string;
	command: string;
} | null {
	const state = readSessionState();
	if (!state.test_passed_at) return null;
	return { passed_at: state.test_passed_at, command: state.test_command ?? "" };
}

export function recordTestPass(command: string): void {
	const state = readSessionState();
	state.test_passed_at = new Date().toISOString();
	state.test_command = command;
	writeState(state);
}

// ── Review gate ─────────────────────────────────────────────

export function readLastReview(): { reviewed_at: string } | null {
	const state = readSessionState();
	if (!state.review_completed_at) return null;
	return { reviewed_at: state.review_completed_at };
}

export function recordReview(): void {
	const state = readSessionState();
	state.review_completed_at = new Date().toISOString();
	writeState(state);
}

// ── Commit lifecycle reset ──────────────────────────────────

// ── File edit counts (persisted to DB, cross-subprocess) ─────────

/** Increment edit count for a file in the DB. Returns the new count. */
export function incrementFileEditCount(file: string): number {
	try {
		const db = getDb();
		const pid = getProjectId();
		db.prepare(
			"INSERT INTO file_edit_counts (project_id, file, count) VALUES (?, ?, 1) ON CONFLICT(project_id, file) DO UPDATE SET count = count + 1",
		).run(pid, file);
		const row = db
			.prepare("SELECT count FROM file_edit_counts WHERE project_id = ? AND file = ?")
			.get(pid, file) as { count: number } | null;
		return row?.count ?? 1;
	} catch (err) {
		process.stderr.write(
			`[qult] file_edit_counts error: ${err instanceof Error ? err.message : "unknown"} — iterative escalation may be degraded\n`,
		);
		return 1;
	}
}

/** Read the current edit count for a file. Returns 0 if untracked. */
export function readFileEditCount(file: string): number {
	try {
		const db = getDb();
		const pid = getProjectId();
		const row = db
			.prepare("SELECT count FROM file_edit_counts WHERE project_id = ? AND file = ?")
			.get(pid, file) as { count: number } | null;
		return row?.count ?? 0;
	} catch {
		return 0;
	}
}

/** Reset all file edit counts for this session (called on commit). */
export function resetFileEditCounts(): void {
	try {
		const db = getDb();
		const pid = getProjectId();
		db.prepare("DELETE FROM file_edit_counts WHERE project_id = ?").run(pid);
	} catch {
		/* fail-open */
	}
}

export function clearOnCommit(): void {
	const state = readSessionState();
	state.last_commit_at = new Date().toISOString();
	state.test_passed_at = null;
	state.test_command = null;
	state.review_completed_at = null;
	state.ran_gates = {};
	state.changed_file_paths = [];
	state.review_iteration = 0;
	state.review_score_history = [];
	state.review_stage_scores = {};
	state.plan_eval_iteration = 0;
	state.plan_eval_score_history = [];
	state.plan_selfcheck_blocked_at = null;
	state.task_verify_results = {};
	state.gate_failure_counts = {};
	state.security_warning_count = 0;
	state.test_quality_warning_count = 0;
	state.drift_warning_count = 0;
	state.dead_import_warning_count = 0;
	state.duplication_warning_count = 0;
	state.semantic_warning_count = 0;
	state.human_review_approved_at = null;
	resetFileEditCounts();
	writeState(state);
}

// ── Review iteration tracking ───────────────────────────────

export function getReviewIteration(): number {
	return readSessionState().review_iteration ?? 0;
}

export function recordReviewIteration(aggregate: number): void {
	const state = readSessionState();
	state.review_iteration = (state.review_iteration ?? 0) + 1;
	state.review_score_history.push(aggregate);
	writeState(state);
}

export function getReviewScoreHistory(): number[] {
	return readSessionState().review_score_history;
}

export function resetReviewIteration(): void {
	const state = readSessionState();
	state.review_iteration = 0;
	state.review_score_history = [];
	writeState(state);
}

// ── Review stage scores (3-stage aggregate) ───────────────────

export function recordStageScores(stageName: string, scores: Record<string, number>): void {
	const state = readSessionState();
	if (!state.review_stage_scores) state.review_stage_scores = {};
	state.review_stage_scores[stageName] = scores;
	writeState(state);
}

export function getStageScores(): Record<string, Record<string, number>> {
	return readSessionState().review_stage_scores ?? {};
}

export function clearStageScores(): void {
	const state = readSessionState();
	state.review_stage_scores = {};
	writeState(state);
}

// ── Plan evaluation iteration tracking ──────────────────────

export function getPlanEvalIteration(): number {
	return readSessionState().plan_eval_iteration ?? 0;
}

export function recordPlanEvalIteration(aggregate: number): void {
	const state = readSessionState();
	state.plan_eval_iteration = (state.plan_eval_iteration ?? 0) + 1;
	state.plan_eval_score_history.push(aggregate);
	writeState(state);
}

export function getPlanEvalScoreHistory(): number[] {
	return readSessionState().plan_eval_score_history;
}

export function resetPlanEvalIteration(): void {
	const state = readSessionState();
	state.plan_eval_iteration = 0;
	state.plan_eval_score_history = [];
	writeState(state);
}

// ── Gate failure escalation ─────────────────────────────

const MAX_GATE_FAILURE_COUNT = 100;
const MAX_GATE_FAILURE_KEYS = 200;

export function incrementGateFailure(file: string, gateName: string): number {
	const state = readSessionState();
	if (!state.gate_failure_counts) state.gate_failure_counts = {};
	const key = `${file}:${gateName}`;
	const count = Math.min((state.gate_failure_counts[key] ?? 0) + 1, MAX_GATE_FAILURE_COUNT);
	state.gate_failure_counts[key] = count;

	const keys = Object.keys(state.gate_failure_counts);
	if (keys.length > MAX_GATE_FAILURE_KEYS) {
		const sorted = [...keys].sort(
			(a, b) => (state.gate_failure_counts[a] ?? 0) - (state.gate_failure_counts[b] ?? 0),
		);
		const toRemove = sorted.slice(0, keys.length - MAX_GATE_FAILURE_KEYS);
		for (const k of toRemove) {
			delete state.gate_failure_counts[k];
		}
	}

	writeState(state);
	return count;
}

export function resetGateFailure(file: string, gateName: string): void {
	const state = readSessionState();
	if (!state.gate_failure_counts) return;
	const key = `${file}:${gateName}`;
	if (key in state.gate_failure_counts) {
		delete state.gate_failure_counts[key];
		writeState(state);
	}
}

// ── Gate override ───────────────────────────────────────

export function isGateDisabled(gateName: string): boolean {
	const state = readSessionState();
	return (state.disabled_gates ?? []).includes(gateName);
}

export function disableGate(gateName: string): void {
	const state = readSessionState();
	if (!state.disabled_gates) state.disabled_gates = [];
	if (!state.disabled_gates.includes(gateName)) {
		state.disabled_gates.push(gateName);
	}
	writeState(state);
}

export function enableGate(gateName: string): void {
	const state = readSessionState();
	state.disabled_gates = (state.disabled_gates ?? []).filter((g) => g !== gateName);
	writeState(state);
}

// ── Finish started marker ────────────────────────────────────

const FINISH_MARKER = "__finish_started__";

export function wasFinishStarted(): boolean {
	try {
		return FINISH_MARKER in readSessionState().ran_gates;
	} catch {
		return false; // fail-open
	}
}

export function recordFinishStarted(): void {
	try {
		const state = readSessionState();
		state.ran_gates[FINISH_MARKER] = {
			ran_at: new Date().toISOString(),
		};
		writeState(state);
	} catch {
		/* fail-open */
	}
}

// ── Human review approval ─────────────────────────────────

export function recordHumanApproval(): void {
	const state = readSessionState();
	state.human_review_approved_at = new Date().toISOString();
	writeState(state);
}

export function readHumanApproval(): { approved_at: string } | null {
	const state = readSessionState();
	if (!state.human_review_approved_at) return null;
	return { approved_at: state.human_review_approved_at };
}
