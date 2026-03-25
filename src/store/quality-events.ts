import type { QualityEvent, QualityEventType, QualityScore } from "../types.js";
import type { Store } from "./index.js";

export function insertQualityEvent(
	store: Store,
	projectId: string,
	sessionId: string,
	eventType: QualityEventType,
	data: Record<string, unknown> = {},
): number {
	const result = store.db
		.prepare(`
			INSERT INTO quality_events (project_id, session_id, event_type, data)
			VALUES (?, ?, ?, ?)
		`)
		.run(projectId, sessionId, eventType, JSON.stringify(data));
	return Number(result.lastInsertRowid);
}

export function getSessionSummary(
	store: Store,
	sessionId: string,
): Record<QualityEventType, number> {
	const rows = store.db
		.prepare(`
			SELECT event_type, COUNT(*) as cnt
			FROM quality_events WHERE session_id = ?
			GROUP BY event_type
		`)
		.all(sessionId) as Array<{ event_type: string; cnt: number }>;

	const summary: Record<string, number> = {};
	for (const r of rows) {
		summary[r.event_type] = r.cnt;
	}
	return summary as Record<QualityEventType, number>;
}

export function calculateQualityScore(
	store: Store,
	sessionId: string,
): QualityScore {
	const summary = getSessionSummary(store, sessionId);

	const gateWritePass = summary.gate_pass ?? 0;
	const gateWriteFail = summary.gate_fail ?? 0;
	const gateWriteTotal = gateWritePass + gateWriteFail;
	const gateWriteRate = gateWriteTotal > 0 ? gateWritePass / gateWriteTotal : 1;

	const errorHit = summary.error_hit ?? 0;
	const errorMiss = summary.error_miss ?? 0;
	const errorTotal = errorHit + errorMiss;
	const errorHitRate = errorTotal > 0 ? errorHit / errorTotal : 0;

	const convPass = summary.convention_pass ?? 0;
	const convWarn = summary.convention_warn ?? 0;
	const convTotal = convPass + convWarn;
	const convRate = convTotal > 0 ? convPass / convTotal : 1;

	// Weighted score: gate_write 30%, gate_commit 20%, error_resolution 15%, convention 10%, base 25%
	const score = Math.round(
		gateWriteRate * 30 +
		gateWriteRate * 20 + // on_commit uses same events for now
		errorHitRate * 15 +
		convRate * 10 +
		25, // base score
	);

	return {
		sessionScore: Math.min(100, Math.max(0, score)),
		breakdown: {
			gatePassRateWrite: { score: Math.round(gateWriteRate * 100), pass: gateWritePass, total: gateWriteTotal },
			gatePassRateCommit: { score: Math.round(gateWriteRate * 100), pass: gateWritePass, total: gateWriteTotal },
			errorResolutionHit: { score: Math.round(errorHitRate * 100), hit: errorHit, total: errorTotal },
			conventionAdherence: { score: Math.round(convRate * 100), pass: convPass, total: convTotal },
		},
		trend: computeTrend(store, score),
	};
}

/**
 * Compute trend by comparing current score to recent session averages.
 */
function computeTrend(store: Store, currentScore: number): "improving" | "stable" | "declining" {
	try {
		// Get distinct recent session IDs (excluding current-ish ones)
		const rows = store.db
			.prepare(`
				SELECT DISTINCT session_id FROM quality_events
				WHERE session_id NOT LIKE 'session-%'
				ORDER BY created_at DESC LIMIT 5
			`)
			.all() as Array<{ session_id: string }>;

		if (rows.length < 2) return "stable";

		// Calculate average score of previous sessions
		let totalScore = 0;
		let count = 0;
		for (const r of rows) {
			const prev = calculateQualityScoreRaw(store, r.session_id);
			if (prev > 0) {
				totalScore += prev;
				count++;
			}
		}
		if (count === 0) return "stable";

		const avg = totalScore / count;
		const diff = currentScore - avg;
		if (diff >= 5) return "improving";
		if (diff <= -5) return "declining";
		return "stable";
	} catch {
		return "stable";
	}
}

/** Raw score calculation without trend (avoids recursion). */
function calculateQualityScoreRaw(store: Store, sessionId: string): number {
	const summary = getSessionSummary(store, sessionId);
	const gp = summary.gate_pass ?? 0;
	const gf = summary.gate_fail ?? 0;
	const gt = gp + gf;
	const gRate = gt > 0 ? gp / gt : 1;
	const eh = summary.error_hit ?? 0;
	const em = summary.error_miss ?? 0;
	const et = eh + em;
	const eRate = et > 0 ? eh / et : 0;
	const cp = summary.convention_pass ?? 0;
	const cw = summary.convention_warn ?? 0;
	const ct = cp + cw;
	const cRate = ct > 0 ? cp / ct : 1;
	return Math.min(100, Math.max(0, Math.round(gRate * 30 + gRate * 20 + eRate * 15 + cRate * 10 + 25)));
}

export function getRecentEvents(
	store: Store,
	sessionId: string,
	limit = 10,
): QualityEvent[] {
	const rows = store.db
		.prepare(`
			SELECT id, project_id, session_id, event_type, data, created_at
			FROM quality_events WHERE session_id = ?
			ORDER BY created_at DESC LIMIT ?
		`)
		.all(sessionId, limit) as Array<{
		id: number;
		project_id: string;
		session_id: string;
		event_type: string;
		data: string;
		created_at: string;
	}>;

	return rows.map((r) => ({
		id: r.id,
		projectId: r.project_id,
		sessionId: r.session_id,
		eventType: r.event_type as QualityEventType,
		data: r.data,
		createdAt: r.created_at,
	}));
}
