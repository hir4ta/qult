/**
 * Pure layout calculator for the dashboard. Maps terminal columns/rows to a
 * tier (wide / medium / narrow) plus a recommended event-log line count.
 *
 * Hysteresis is applied at the tier boundaries (±2 cols) so resize jitter
 * around 60 / 90 cols doesn't flicker the UI.
 */

export type LayoutTier = "wide" | "medium" | "narrow";

export interface Layout {
	tier: LayoutTier;
	eventLogLines: number;
}

const WIDE_THRESHOLD = 90;
const MEDIUM_THRESHOLD = 60;
export const HYSTERESIS = 2;

const RESERVED_ROWS_BY_TIER: Record<LayoutTier, number> = {
	wide: 12,
	medium: 16,
	narrow: 20,
};

const MIN_EVENT_LOG_LINES = 3;

function tierFor(cols: number): LayoutTier {
	if (cols >= WIDE_THRESHOLD) return "wide";
	if (cols >= MEDIUM_THRESHOLD) return "medium";
	return "narrow";
}

/**
 * Compute the layout for a given terminal size, optionally applying
 * hysteresis around the tier transitions when a previous tier is provided.
 */
export function computeLayout(cols: number, rows: number, previous?: LayoutTier): Layout {
	const raw = tierFor(cols);
	let tier = raw;
	if (previous !== undefined && previous !== raw) {
		// Stay on the previous tier if we're within ±HYSTERESIS of the
		// boundary that separates it from the new raw tier. Each branch
		// guards exactly one boundary so we can't accidentally stick on
		// `medium` while crossing fully into `wide` (and vice versa).
		if (previous === "wide" && cols >= WIDE_THRESHOLD - HYSTERESIS) {
			tier = "wide";
		} else if (previous === "medium") {
			if (raw === "wide" && cols < WIDE_THRESHOLD + HYSTERESIS) tier = "medium";
			else if (raw === "narrow" && cols >= MEDIUM_THRESHOLD - HYSTERESIS) tier = "medium";
		} else if (previous === "narrow" && cols < MEDIUM_THRESHOLD + HYSTERESIS) {
			tier = "narrow";
		}
	}

	const reserved = RESERVED_ROWS_BY_TIER[tier];
	const eventLogLines = Math.max(MIN_EVENT_LOG_LINES, rows - reserved);
	return { tier, eventLogLines };
}
