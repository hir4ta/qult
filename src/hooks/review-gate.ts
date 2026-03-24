import { tryReadActiveSpec } from "./spec-guard.js";
import { readStateJSON, writeStateJSON } from "./state.js";

const GATE_FILE = "review-gate.json";

export interface ReviewGate {
	gate: "spec-review" | "wave-review";
	slug: string;
	wave?: number;
	set_at: string;
	reason: string;
	/** When true, Edit/Write is allowed for applying fixes, but gate stays logically active.
	 *  Next `gate clear` fully removes the gate. Enables review→fix→re-review loop (#15/#20). */
	fix_mode?: boolean;
	/** ISO8601 timestamp when fix_mode was entered. Auto-expires after 60 minutes. */
	fix_mode_at?: string;
	/** FR-9: Set to true when a review is executed after entering fix_mode.
	 *  Gate clear is blocked while fix_mode=true and re_reviewed=false. */
	re_reviewed?: boolean;
	/** ISO8601 timestamp when re_reviewed was set to true. */
	re_reviewed_at?: string;
}

/**
 * Read review gate state. Returns null if missing, corrupted, or invalid.
 * Fail-open: errors return null + stderr warning (NFR-1).
 */
export function readReviewGate(cwd: string): ReviewGate | null {
	const data = readStateJSON<ReviewGate | null>(cwd, GATE_FILE, null);
	if (!data || !data.gate || !data.slug) return null;
	if (data.gate !== "spec-review" && data.gate !== "wave-review") {
		process.stderr.write(`[alfred] review-gate: invalid gate type "${data.gate}", ignoring\n`);
		return null;
	}
	return data;
}

/**
 * Check if gate is active AND slug matches current active spec.
 * Returns null if no gate, slug mismatch (stale), or any error (fail-open).
 */
export function isGateActive(cwd: string): ReviewGate | null {
	const gate = readReviewGate(cwd);
	if (!gate) return null;

	const spec = tryReadActiveSpec(cwd);
	if (!spec) return null;

	// Slug mismatch = stale gate from previous spec. Ignore.
	if (gate.slug !== spec.slug) return null;

	// Fix mode timeout: auto-expire after 60 minutes.
	if (gate.fix_mode && gate.fix_mode_at) {
		const elapsed = Date.now() - Date.parse(gate.fix_mode_at);
		if (Number.isNaN(elapsed) || elapsed > 60 * 60 * 1000) {
			gate.fix_mode = false;
			gate.fix_mode_at = undefined;
			gate.re_reviewed = false;
			gate.re_reviewed_at = undefined;
			writeStateJSON(cwd, GATE_FILE, gate);
			process.stderr.write("[alfred] fix_mode expired (60 min timeout). Gate re-activated — run review before clearing.\n");
		}
	}

	return gate;
}

/**
 * Write review gate with auto-populated set_at timestamp.
 */
export function writeReviewGate(
	cwd: string,
	gate: Omit<ReviewGate, "set_at">,
): void {
	const full: ReviewGate = { ...gate, set_at: new Date().toISOString() };
	writeStateJSON(cwd, GATE_FILE, full);
}

/**
 * Clear review gate (write null).
 */
export function clearReviewGate(cwd: string): void {
	writeStateJSON(cwd, GATE_FILE, null);
}
