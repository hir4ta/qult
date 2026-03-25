/**
 * Data layer for TUI (v2) — reads quality events from DB.
 * TODO (Phase 4): Implement quality dashboard data layer.
 */

export interface QualityDashboardData {
	score: number;
	gates: {
		onWrite: { pass: number; fail: number };
		onCommit: { pass: number; fail: number };
	};
	knowledge: {
		errorResolutionHits: number;
		errorResolutionMisses: number;
		exemplarInjections: number;
		conventionAdherence: number;
	};
	recentEvents: Array<{
		timestamp: string;
		type: string;
		detail: string;
	}>;
}

export function loadDashboardData(): QualityDashboardData {
	// TODO (Phase 4): Load from quality_events table
	return {
		score: 0,
		gates: { onWrite: { pass: 0, fail: 0 }, onCommit: { pass: 0, fail: 0 } },
		knowledge: { errorResolutionHits: 0, errorResolutionMisses: 0, exemplarInjections: 0, conventionAdherence: 0 },
		recentEvents: [],
	};
}
