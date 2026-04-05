import type { QultConfig } from "./config.ts";

/** Review depth tier based on change scope. */
export type ReviewTier = "skip" | "light" | "standard" | "deep";

/** Deep review threshold (files). */
const DEEP_THRESHOLD = 8;

/**
 * Determine review tier based on change scope.
 *
 * - skip: 1-2 files, no plan → no review needed
 * - light: 3+ files below required_changed_files, no plan → 2-stage (Spec + Quality)
 * - standard: >= required_changed_files or plan active → full 4-stage review
 * - deep: 8+ files → 4-stage + on_review gates (e2e)
 */
export function computeReviewTier(
	changedFiles: number,
	hasPlan: boolean,
	config: QultConfig,
): ReviewTier {
	const threshold = config.review.required_changed_files;

	// Deep: large changes always get full treatment + e2e
	if (changedFiles >= DEEP_THRESHOLD) return "deep";

	// Standard: plan active or at/above threshold
	if (hasPlan || changedFiles >= threshold) return "standard";

	// Light: 3+ files but below threshold
	if (changedFiles >= 3) return "light";

	// Skip: small change, no plan
	return "skip";
}
