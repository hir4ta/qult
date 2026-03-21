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
