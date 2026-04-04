import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { loadGates } from "../gates/load.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { getActivePlan } from "./plan-status.ts";

const STATE_DIR = ".qult/.state";
const FILE = "session-state.json";

// Process-scoped cache: read once from disk, flush once at end
let _cache: SessionState | null = null;
let _dirty = false;

// Session-scoped file path: session-state-{sessionId}.json
let _sessionScope: string | null = null;

/** Set session scope for state file isolation. Rejects path-traversal characters. */
export function setStateSessionScope(sessionId: string): void {
	if (!/^[\w-]+$/.test(sessionId)) return;
	_sessionScope = sessionId;
}

/**
 * Per-session quality state.
 *
 * Fields are grouped by domain. Each group is managed by dedicated
 * helper functions below — avoid mutating fields directly.
 */
export interface SessionState {
	// ── Commit lifecycle ─────────────────────────────────────
	/** When the last commit gate reset occurred (ISO timestamp) */
	last_commit_at: string;

	// ── Test gate ────────────────────────────────────────────
	/** When tests last passed (ISO timestamp, null = not passed since last commit) */
	test_passed_at: string | null;
	/** The test command that was detected as passing */
	test_command: string | null;

	// ── Review gate ──────────────────────────────────────────
	/** When independent review last completed (ISO timestamp) */
	review_completed_at: string | null;
	/** Number of review iterations in current cycle (0 = not started) */
	review_iteration: number;
	/** Aggregate scores per iteration for trend detection */
	review_score_history: number[];
	/** Per-stage scores for 3-stage aggregate (e.g. {"Spec": {"completeness": 5, "accuracy": 4}}) */
	review_stage_scores: Record<string, Record<string, number>>;

	// ── Plan evaluation ──────────────────────────────────────
	/** Number of plan evaluation iterations (0 = not started) */
	plan_eval_iteration: number;
	/** Aggregate scores per iteration for trend detection */
	plan_eval_score_history: number[];
	/** When ExitPlanMode was first denied for selfcheck (null = not yet) */
	plan_selfcheck_blocked_at: string | null;

	// ── Gate batch tracking ──────────────────────────────────
	/** Per-gate run tracking for run_once_per_batch dedup */
	ran_gates: Record<string, { session_id: string; ran_at: string }>;

	// ── File tracking ────────────────────────────────────────
	/** Files edited this session (for review threshold) */
	changed_file_paths: string[];

	// ── Gate override ────────────────────────────────────────
	/** Gates temporarily disabled for this session */
	disabled_gates: string[];

	// ── TDD RED verification ─────────────────────────────────
	/** Per-task Verify test results for RED-GREEN enforcement (key = "Task N") */
	task_verify_results: Record<string, { passed: boolean; ran_at: string }>;

	// ── Gate failure escalation ──────────────────────────────
	/** Per-file:gate failure count for 3-Strike escalation (key = "file:gate") */
	gate_failure_counts: Record<string, number>;
}

function filePath(): string {
	const file = _sessionScope ? `session-state-${_sessionScope}.json` : FILE;
	return join(process.cwd(), STATE_DIR, file);
}

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
	};
}

/** Read session state. Returns defaults on error (fail-open). */
export function readSessionState(): SessionState {
	if (_cache) return _cache;
	try {
		const path = filePath();
		if (!existsSync(path)) {
			_cache = defaultState();
			return _cache;
		}
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		// Migrate legacy scalar fields before merge
		if (
			!Array.isArray(raw.review_score_history) &&
			typeof raw.review_last_aggregate === "number" &&
			raw.review_last_aggregate > 0
		) {
			raw.review_score_history = [raw.review_last_aggregate];
		}
		if (
			!Array.isArray(raw.plan_eval_score_history) &&
			typeof raw.plan_eval_last_aggregate === "number" &&
			raw.plan_eval_last_aggregate > 0
		) {
			raw.plan_eval_score_history = [raw.plan_eval_last_aggregate];
		}
		const state = { ...defaultState(), ...raw };
		// Validate review_stage_scores shape (must be Record<string, Record<string, number>>)
		if (
			state.review_stage_scores &&
			(typeof state.review_stage_scores !== "object" || Array.isArray(state.review_stage_scores))
		) {
			state.review_stage_scores = {};
		}
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

/** Flush cached state to disk if dirty. */
export function flush(): void {
	if (!_dirty || !_cache) return;
	try {
		atomicWriteJson(filePath(), _cache);
	} catch (e) {
		if (e instanceof Error) process.stderr.write(`[qult] state write error: ${e.message}\n`);
	}
	_dirty = false;
}

/** Reset cache (for tests). */
export function resetCache(): void {
	_cache = null;
	_dirty = false;
	_sessionScope = null;
}

// ── File extension heuristic (for gated-file filtering) ─────

// Tool keyword → file extensions the tool meaningfully checks
const TOOL_EXTS: [RegExp, string[]][] = [
	[/\bbiome\b/, [".js", ".jsx", ".ts", ".tsx", ".css", ".graphql"]],
	[/\beslint\b/, [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"]],
	[/\btsc\b/, [".ts", ".tsx", ".mts", ".cts"]],
	[/\bpyright\b/, [".py", ".pyi"]],
	[/\bmypy\b/, [".py", ".pyi"]],
	[/\bruff\b/, [".py", ".pyi"]],
	[/\bgo\s+(vet|build)\b/, [".go"]],
	[/\bcargo\s+(clippy|check)\b/, [".rs"]],
];

/** Get file extensions covered by on_write gates.
 *  If a gate defines `extensions`, those are used directly.
 *  Otherwise, falls back to TOOL_EXTS heuristic. */
export function getGatedExtensions(): Set<string> {
	const gates = loadGates();
	if (!gates?.on_write) return new Set();

	const exts = new Set<string>();
	for (const gate of Object.values(gates.on_write)) {
		if (gate.extensions && gate.extensions.length > 0) {
			for (const ext of gate.extensions) exts.add(ext);
		} else {
			for (const [pattern, extensions] of TOOL_EXTS) {
				if (pattern.test(gate.command)) {
					for (const ext of extensions) exts.add(ext);
				}
			}
		}
	}
	return exts;
}

// ── File tracking ───────────────────────────────────────────

/** Record a changed file path (deduplicated) */
export function recordChangedFile(filePath: string): void {
	const state = readSessionState();
	if (!state.changed_file_paths) state.changed_file_paths = [];
	if (!state.changed_file_paths.includes(filePath)) {
		state.changed_file_paths.push(filePath);
	}
	writeState(state);
}

/** Determine if independent review is required for current session.
 *  Required when: plan is active OR changed_files >= threshold. */
export function isReviewRequired(): boolean {
	if (getActivePlan() !== null) return true;
	const state = readSessionState();
	const changedCount = state.changed_file_paths?.length ?? 0;
	if (changedCount >= loadConfig().review.required_changed_files) return true;
	return false;
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

// ── Gate batch dedup ────────────────────────────────────────

export function shouldSkipGate(gateName: string, sessionId: string): boolean {
	const state = readSessionState();
	const entry = state.ran_gates[gateName];
	if (!entry) return false;
	return entry.session_id === sessionId;
}

export function markGateRan(gateName: string, sessionId: string): void {
	const state = readSessionState();
	state.ran_gates[gateName] = {
		session_id: sessionId,
		ran_at: new Date().toISOString(),
	};
	writeState(state);
}

// ── Commit lifecycle reset ──────────────────────────────────

/** Clear all per-commit fields. Called when git commit is detected. */
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
	writeState(state);
}

// ── Review iteration tracking ───────────────────────────────

/** Get current review iteration count (0 = not started). */
export function getReviewIteration(): number {
	return readSessionState().review_iteration ?? 0;
}

/** Record a review iteration with aggregate score. Increments iteration counter. */
export function recordReviewIteration(aggregate: number): void {
	const state = readSessionState();
	state.review_iteration = (state.review_iteration ?? 0) + 1;
	state.review_score_history.push(aggregate);
	writeState(state);
}

/** Get review score history (one entry per iteration). */
export function getReviewScoreHistory(): number[] {
	return readSessionState().review_score_history;
}

/** Reset review iteration state (called on review gate clear). */
export function resetReviewIteration(): void {
	const state = readSessionState();
	state.review_iteration = 0;
	state.review_score_history = [];
	writeState(state);
}

// ── Review stage scores (3-stage aggregate) ───────────────────

/** Record scores for a review stage (e.g., "Spec", "Quality", "Security"). */
export function recordStageScores(stageName: string, scores: Record<string, number>): void {
	const state = readSessionState();
	if (!state.review_stage_scores) state.review_stage_scores = {};
	state.review_stage_scores[stageName] = scores;
	writeState(state);
}

/** Get all recorded stage scores. Returns empty object if none. */
export function getStageScores(): Record<string, Record<string, number>> {
	return readSessionState().review_stage_scores ?? {};
}

/** Clear all stage scores (after aggregate check or on commit reset). */
export function clearStageScores(): void {
	const state = readSessionState();
	state.review_stage_scores = {};
	writeState(state);
}

// ── Plan evaluation iteration tracking ──────────────────────

/** Get current plan evaluation iteration count (0 = not started). */
export function getPlanEvalIteration(): number {
	return readSessionState().plan_eval_iteration ?? 0;
}

/** Record a plan evaluation iteration with aggregate score. */
export function recordPlanEvalIteration(aggregate: number): void {
	const state = readSessionState();
	state.plan_eval_iteration = (state.plan_eval_iteration ?? 0) + 1;
	state.plan_eval_score_history.push(aggregate);
	writeState(state);
}

/** Get plan evaluation score history. */
export function getPlanEvalScoreHistory(): number[] {
	return readSessionState().plan_eval_score_history;
}

/** Reset plan evaluation iteration state. */
export function resetPlanEvalIteration(): void {
	const state = readSessionState();
	state.plan_eval_iteration = 0;
	state.plan_eval_score_history = [];
	writeState(state);
}

// ── TDD RED verification ────────────────────────────────

/** Record a task's Verify test result (pass/fail). Key is "Task N". */
export function recordTaskVerifyResult(taskKey: string, passed: boolean): void {
	const state = readSessionState();
	if (!state.task_verify_results) state.task_verify_results = {};
	state.task_verify_results[taskKey] = { passed, ran_at: new Date().toISOString() };
	writeState(state);
}

/** Read a task's Verify test result. Returns null if not yet recorded. */
export function readTaskVerifyResult(taskKey: string): { passed: boolean; ran_at: string } | null {
	const state = readSessionState();
	return state.task_verify_results?.[taskKey] ?? null;
}

// ── Gate failure escalation ─────────────────────────────

/** Increment gate failure count for a file:gate combination. Returns the new count. */
export function incrementGateFailure(file: string, gateName: string): number {
	const state = readSessionState();
	if (!state.gate_failure_counts) state.gate_failure_counts = {};
	const key = `${file}:${gateName}`;
	const count = (state.gate_failure_counts[key] ?? 0) + 1;
	state.gate_failure_counts[key] = count;
	writeState(state);
	return count;
}

/** Reset gate failure count for a file:gate (called when gate passes). */
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

/** Check if a gate is currently disabled. */
export function isGateDisabled(gateName: string): boolean {
	const state = readSessionState();
	return (state.disabled_gates ?? []).includes(gateName);
}

/** Disable a gate for the current session. */
export function disableGate(gateName: string): void {
	const state = readSessionState();
	if (!state.disabled_gates) state.disabled_gates = [];
	if (!state.disabled_gates.includes(gateName)) {
		state.disabled_gates.push(gateName);
	}
	writeState(state);
}

/** Re-enable a previously disabled gate. */
export function enableGate(gateName: string): void {
	const state = readSessionState();
	state.disabled_gates = (state.disabled_gates ?? []).filter((g) => g !== gateName);
	writeState(state);
}

// ── Plan selfcheck gate ─────────────────────────────────────

/** Check if plan selfcheck has already been blocked (1-time gate). */
export function wasPlanSelfcheckBlocked(): boolean {
	return readSessionState().plan_selfcheck_blocked_at != null;
}

/** Record that plan selfcheck deny was issued. Next ExitPlanMode will pass. */
export function recordPlanSelfcheckBlocked(): void {
	const state = readSessionState();
	state.plan_selfcheck_blocked_at = new Date().toISOString();
	writeState(state);
}
