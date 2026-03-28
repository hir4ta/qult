import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { loadGates } from "../gates/load.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { getActivePlan } from "./plan-status.ts";

const STATE_DIR = ".qult/.state";
const FILE = "session-state.json";
const DEFAULT_REVIEW_FILE_THRESHOLD = 5;

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
	last_commit_at: string;
	test_passed_at: string | null;
	test_command: string | null;
	review_completed_at: string | null;
	ran_gates: Record<string, { session_id: string; ran_at: string }>;
	changed_file_paths: string[];
	review_iteration: number;
	review_last_aggregate: number;
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
		review_last_aggregate: 0,
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

// --- Review threshold ---

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

/** Determine if independent review is required for current session.
 *  Required when: plan is active OR gated_files >= threshold.
 *  Files outside gate coverage (e.g. .md) don't count toward threshold. */
export function isReviewRequired(): boolean {
	if (getActivePlan() !== null) return true;
	if (countGatedFiles() >= DEFAULT_REVIEW_FILE_THRESHOLD) return true;
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

// --- Commit reset ---

/** Clear per-commit fields. */
export function clearOnCommit(): void {
	const state = readSessionState();
	state.last_commit_at = new Date().toISOString();
	state.test_passed_at = null;
	state.test_command = null;
	state.review_completed_at = null;
	state.ran_gates = {};
	state.changed_file_paths = [];
	state.review_iteration = 0;
	state.review_last_aggregate = 0;
	writeState(state);
}

// --- Review iteration tracking ---

/** Get current review iteration count (0 = not started). */
export function getReviewIteration(): number {
	return readSessionState().review_iteration ?? 0;
}

/** Record a review iteration with aggregate score. Increments iteration counter. */
export function recordReviewIteration(aggregate: number): void {
	const state = readSessionState();
	state.review_iteration = (state.review_iteration ?? 0) + 1;
	state.review_last_aggregate = aggregate;
	writeState(state);
}

/** Reset review iteration state (called on review gate clear). */
export function resetReviewIteration(): void {
	const state = readSessionState();
	state.review_iteration = 0;
	state.review_last_aggregate = 0;
	writeState(state);
}
