import type { QultConfig } from "./config.ts";

/** Review depth tier based on change scope. */
export type ReviewTier = "skip" | "light" | "standard" | "deep";

/** Deep review threshold (files). */
const DEEP_THRESHOLD = 8;

/** File path patterns that indicate high-risk changes requiring deeper review.
 *  Matches source files containing these keywords as directory or file name segments.
 *  Excludes non-source files (docs, configs) via SOURCE_EXT_RE check at call site. */
const HIGH_RISK_RE =
	/(?:^|\/)(?:auth|security|crypto|secret|permission|credential|session|token|password|oauth|saml|jwt)(?:\/|[^/]*\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py|pyi|go|rs|rb|java|kt|php|cs)$)/i;

/** Source code extensions for test-absence escalation. */
const SOURCE_EXT_RE =
	/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py|pyi|go|rs|rb|java|kt|php|cs|vue|svelte)$/;

/**
 * Determine review tier based on change scope.
 *
 * - skip: 1-2 files, no plan → no review needed
 * - light: 3+ files below required_changed_files, no plan → 2-stage (Spec + Quality)
 * - standard: >= required_changed_files or plan active → full 4-stage review
 * - deep: 8+ files, or high-risk files changed, or code changes without tests → 4-stage + on_review gates (e2e)
 */
export function computeReviewTier(
	changedFiles: number,
	hasPlan: boolean,
	config: QultConfig,
	changedFilePaths?: string[],
): ReviewTier {
	const threshold = config.review.required_changed_files;

	// Deep: large changes always get full treatment + e2e
	if (changedFiles >= DEEP_THRESHOLD) return "deep";

	// Risk-based escalation (when file paths are available)
	if (changedFilePaths && changedFilePaths.length > 0) {
		// High-risk files (auth, security, crypto, etc.) → deep
		if (changedFilePaths.some((p) => HIGH_RISK_RE.test(p))) return "deep";

		// Code changes without any test changes → escalate one tier
		const hasCodeChanges = changedFilePaths.some(
			(p) =>
				SOURCE_EXT_RE.test(p) &&
				!p.includes(".test.") &&
				!p.includes(".spec.") &&
				!p.includes("__tests__"),
		);
		const hasTestChanges = changedFilePaths.some(
			(p) =>
				p.includes(".test.") ||
				p.includes(".spec.") ||
				p.includes("__tests__") ||
				/_test\.go$/.test(p) ||
				/_spec\.rb$/.test(p) ||
				/\/test_[^/]+\.py$/.test(p) ||
				/\/tests\//.test(p),
		);
		if (hasCodeChanges && !hasTestChanges && changedFiles >= 3) {
			// Escalate: light → standard, standard → deep
			if (hasPlan || changedFiles >= threshold) return "deep";
			return "standard";
		}
	}

	// Standard: plan active or at/above threshold
	if (hasPlan || changedFiles >= threshold) return "standard";

	// Light: 3+ files but below threshold
	if (changedFiles >= 3) return "light";

	// Skip: small change, no plan
	return "skip";
}
