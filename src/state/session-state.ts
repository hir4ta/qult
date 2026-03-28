import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { loadGates } from "../gates/load.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { getCalibrated } from "./calibration.ts";
import { getCommitStats } from "./gate-history.ts";
import { getActivePlan } from "./plan-status.ts";

const STATE_DIR = ".qult/.state";
const FILE = "session-state.json";
const DEFAULT_RED_MINUTES = 120;
const DEFAULT_FILES = 15;

// Process-scoped cache: read once from disk, flush once at end
let _cache: SessionState | null = null;
let _dirty = false;

// Session-scoped file path: session-state-{sessionId}.json
let _sessionScope: string | null = null;

/** Set session scope for state file isolation. */
export function setStateSessionScope(sessionId: string): void {
	_sessionScope = sessionId;
}

export interface SessionState {
	// Pace tracking
	last_commit_at: string;
	changed_files: number;
	tool_calls: number;
	// Gate clearance
	test_passed_at: string | null;
	test_command: string | null;
	review_completed_at: string | null;
	// Gate batch (run_once_per_batch)
	ran_gates: Record<string, { session_id: string; ran_at: string }>;
	// Failure tracking
	last_error_signature: string;
	consecutive_error_count: number;
	// Context budget
	context_session_id: string;
	context_used: number;
	// Per-session action counters (for outcome tracking)
	session_deny_count: number;
	session_block_count: number;
	session_respond_count: number;
	// First-pass tracking: files already counted (prevents re-counting on re-edit)
	first_pass_recorded: string[];
	// Changed file paths (for gated-file review threshold)
	changed_file_paths: string[];
	// Plan contract tracking (cumulative across session, not reset on commit)
	verified_fields: string[];
	criteria_commands_run: string[];
	// Peak consecutive error tracking
	peak_consecutive_error_count: number;
	// Fix effort: edits between DENY and resolution
	deny_edits_before_resolution: number;
	// LOC tracking: cumulative lines changed since last commit
	changed_lines: number;
	// Advisory compliance tracking
	pending_advisory: PendingAdvisory | null;
}

export interface PendingAdvisory {
	type: "fix" | "error-loop" | "verify-check";
	expected_files?: string[];
	injected_at: string;
}

function filePath(): string {
	const file = _sessionScope ? `session-state-${_sessionScope}.json` : FILE;
	return join(process.cwd(), STATE_DIR, file);
}

function defaultState(): SessionState {
	return {
		last_commit_at: new Date().toISOString(),
		changed_files: 0,
		tool_calls: 0,
		test_passed_at: null,
		test_command: null,
		review_completed_at: null,
		ran_gates: {},
		last_error_signature: "",
		consecutive_error_count: 0,
		context_session_id: "",
		context_used: 0,
		session_deny_count: 0,
		session_block_count: 0,
		session_respond_count: 0,
		first_pass_recorded: [],
		changed_file_paths: [],
		verified_fields: [],
		criteria_commands_run: [],
		peak_consecutive_error_count: 0,
		deny_edits_before_resolution: 0,
		changed_lines: 0,
		pending_advisory: null,
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
		const state = { ...defaultState(), ...raw };
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

// --- Pace ---

export function readPace(): {
	last_commit_at: string;
	changed_files: number;
	tool_calls: number;
} | null {
	// Return null only when both cache and disk are empty (no tracking data yet)
	if (!_cache && !existsSync(filePath())) return null;
	const state = readSessionState();
	return {
		last_commit_at: state.last_commit_at,
		changed_files: state.changed_files,
		tool_calls: state.tool_calls,
	};
}

export function writePace(pace: {
	last_commit_at: string;
	changed_files: number;
	tool_calls: number;
}): void {
	const state = readSessionState();
	state.last_commit_at = pace.last_commit_at;
	state.changed_files = pace.changed_files;
	state.tool_calls = pace.tool_calls;
	writeState(state);
}

export function getRedThreshold(): number {
	try {
		const stats = getCommitStats();
		if (stats && stats.count >= 3) {
			return Math.max(10, Math.min(DEFAULT_RED_MINUTES, stats.avgMinutes * 2));
		}
	} catch {
		// fail-open
	}
	return DEFAULT_RED_MINUTES;
}

export function isPaceRed(
	pace: { last_commit_at: string; changed_files: number } | null,
	hasPlan = false,
): boolean {
	if (!pace) return false;
	const elapsed = Date.now() - new Date(pace.last_commit_at).getTime();
	const minutes = elapsed / 60_000;
	const threshold = hasPlan ? getRedThreshold() * 1.5 : getRedThreshold();
	const calibratedFiles = getCalibrated("pace_files", DEFAULT_FILES);
	const fileThreshold = hasPlan ? Math.ceil(calibratedFiles * 1.5) : calibratedFiles;
	return minutes >= threshold && pace.changed_files >= fileThreshold;
}

// --- Review threshold ---

const DEFAULT_REVIEW_FILE_THRESHOLD = 5;

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

/** Get file extensions covered by on_write gates */
export function getGatedExtensions(): Set<string> {
	const gates = loadGates();
	if (!gates?.on_write) return new Set();

	const exts = new Set<string>();
	for (const gate of Object.values(gates.on_write)) {
		for (const [pattern, extensions] of TOOL_EXTS) {
			if (pattern.test(gate.command)) {
				for (const ext of extensions) exts.add(ext);
			}
		}
	}
	return exts;
}

/** Count changed files covered by on_write gates */
export function countGatedFiles(): number {
	const state = readSessionState();
	const paths = state.changed_file_paths ?? [];
	if (paths.length === 0) return 0;

	const exts = getGatedExtensions();
	if (exts.size === 0) return 0;

	return paths.filter((p) => exts.has(extname(p).toLowerCase())).length;
}

/** Record a changed file path (deduplicated) */
export function recordChangedFile(filePath: string): void {
	const state = readSessionState();
	if (!state.changed_file_paths) state.changed_file_paths = [];
	if (!state.changed_file_paths.includes(filePath)) {
		state.changed_file_paths.push(filePath);
	}
	writeState(state);
}

/** Record a verified plan field (taskName:testFunction) — deduplicated */
export function recordVerifiedField(key: string): void {
	const state = readSessionState();
	if (!state.verified_fields) state.verified_fields = [];
	if (!state.verified_fields.includes(key)) {
		state.verified_fields.push(key);
	}
	writeState(state);
}

/** Record a criteria command as executed — deduplicated */
export function recordCriteriaCommand(command: string): void {
	const state = readSessionState();
	if (!state.criteria_commands_run) state.criteria_commands_run = [];
	if (!state.criteria_commands_run.includes(command)) {
		state.criteria_commands_run.push(command);
	}
	writeState(state);
}

/** Determine if independent review is required for current session.
 *  Required when: plan is active OR gated_files >= threshold.
 *  Files outside gate coverage (e.g. .md) don't count toward threshold. */
export function isReviewRequired(): boolean {
	// Plan active → always require review
	if (getActivePlan() !== null) return true;

	// Count only files covered by on_write gates
	const reviewThreshold = getCalibrated("review_file_threshold", DEFAULT_REVIEW_FILE_THRESHOLD);
	if (countGatedFiles() >= reviewThreshold) return true;

	return false;
}

// --- Test pass ---

export function readLastTestPass(): { passed_at: string; command: string } | null {
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

// --- Review ---

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

// --- Gate batch ---

export function shouldSkipGate(gateName: string, sessionId: string): boolean {
	const state = readSessionState();
	const entry = state.ran_gates[gateName];
	if (!entry) return false;
	return entry.session_id === sessionId;
}

export function markGateRan(gateName: string, sessionId: string): void {
	const state = readSessionState();
	state.ran_gates[gateName] = { session_id: sessionId, ran_at: new Date().toISOString() };
	writeState(state);
}

// --- Fail count ---

export function recordFailure(signature: string): number {
	try {
		const state = readSessionState();
		const count = state.last_error_signature === signature ? state.consecutive_error_count + 1 : 1;
		state.last_error_signature = signature;
		state.consecutive_error_count = count;
		if (count > (state.peak_consecutive_error_count ?? 0)) {
			state.peak_consecutive_error_count = count;
		}
		writeState(state);
		return count;
	} catch {
		return 1;
	}
}

export function clearFailCount(): void {
	const state = readSessionState();
	state.last_error_signature = "";
	state.consecutive_error_count = 0;
	writeState(state);
}

// --- Fix effort tracking ---

/** Increment edit counter for fix effort (editing a file that has pending fixes). */
export function recordEditTowardsFix(): void {
	try {
		const state = readSessionState();
		state.deny_edits_before_resolution = (state.deny_edits_before_resolution ?? 0) + 1;
		writeState(state);
	} catch {
		/* fail-open */
	}
}

/** Reset fix effort counter and return the count (called on resolution). */
export function resetFixEffort(): number {
	try {
		const state = readSessionState();
		const count = state.deny_edits_before_resolution ?? 0;
		state.deny_edits_before_resolution = 0;
		writeState(state);
		return count;
	} catch {
		return 0;
	}
}

// --- LOC tracking ---

/** Read cumulative changed lines since last commit. */
export function readChangedLines(): number {
	return readSessionState().changed_lines ?? 0;
}

/** Record additional changed lines (added to cumulative total). */
export function recordChangedLines(lines: number): void {
	if (lines <= 0) return;
	const state = readSessionState();
	state.changed_lines = (state.changed_lines ?? 0) + lines;
	writeState(state);
}

// --- Action counters ---

export function incrementActionCount(type: "deny" | "block" | "respond"): void {
	const state = readSessionState();
	if (type === "deny") state.session_deny_count++;
	else if (type === "block") state.session_block_count++;
	else state.session_respond_count++;
	writeState(state);
}

// --- First-pass tracking ---

/** Check if this file's first-pass has already been recorded. */
export function isFirstPassRecorded(file: string): boolean {
	const state = readSessionState();
	return (state.first_pass_recorded ?? []).includes(file);
}

/** Mark a file's first-pass as recorded. */
export function markFirstPassRecorded(file: string): void {
	const state = readSessionState();
	if (!state.first_pass_recorded) state.first_pass_recorded = [];
	state.first_pass_recorded.push(file);
	writeState(state);
}

// --- Context budget ---

export function resetBudget(sessionId: string): void {
	const state = readSessionState();
	if (state.context_session_id === sessionId) return;
	state.context_session_id = sessionId;
	state.context_used = 0;
	writeState(state);
}

export function checkBudget(tokens: number): boolean {
	const state = readSessionState();
	if (!state.context_session_id) return true; // fail-open
	const budget = getCalibrated("context_budget", 2000);
	return state.context_used + tokens <= budget;
}

export function recordInjection(tokens: number): void {
	const state = readSessionState();
	state.context_used += tokens;
	writeState(state);
}

// --- Commit reset ---

/** Clear per-commit fields. Preserves budget. Optionally resets pace atomically. */
export function clearOnCommit(paceReset?: {
	last_commit_at: string;
	changed_files: number;
	tool_calls: number;
}): void {
	const state = readSessionState();
	state.test_passed_at = null;
	state.test_command = null;
	state.review_completed_at = null;
	state.ran_gates = {};
	state.changed_file_paths = [];
	state.changed_lines = 0;
	state.session_deny_count = 0;
	state.pending_advisory = null;
	state.last_error_signature = "";
	state.consecutive_error_count = 0;
	if (paceReset) {
		state.last_commit_at = paceReset.last_commit_at;
		state.changed_files = paceReset.changed_files;
		state.tool_calls = paceReset.tool_calls;
	}
	writeState(state);
}

// --- Advisory compliance tracking ---

export function setPendingAdvisory(advisory: PendingAdvisory): void {
	const state = readSessionState();
	state.pending_advisory = advisory;
	writeState(state);
}

export function getPendingAdvisory(): PendingAdvisory | null {
	return readSessionState().pending_advisory ?? null;
}

export function clearPendingAdvisory(): void {
	const state = readSessionState();
	state.pending_advisory = null;
	writeState(state);
}
