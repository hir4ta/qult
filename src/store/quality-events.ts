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

export interface GateBreakdown {
	onWrite: { pass: number; fail: number; total: number; rate: number };
	onCommit: { pass: number; fail: number; total: number; rate: number };
}

/**
 * Separate gate_pass/gate_fail events by group (on_write vs on_commit)
 * by parsing the JSON data field.
 */
export function getGateBreakdown(store: Store, sessionId: string): GateBreakdown {
	const rows = store.db
		.prepare(`
			SELECT event_type, data FROM quality_events
			WHERE session_id = ? AND event_type IN ('gate_pass', 'gate_fail')
		`)
		.all(sessionId) as Array<{ event_type: string; data: string }>;

	const result: GateBreakdown = {
		onWrite: { pass: 0, fail: 0, total: 0, rate: 1 },
		onCommit: { pass: 0, fail: 0, total: 0, rate: 1 },
	};

	for (const row of rows) {
		let group = "on_write";
		try {
			const parsed = JSON.parse(row.data);
			if (parsed.group) group = parsed.group;
		} catch {
			/* default to on_write */
		}

		const bucket = group === "on_commit" ? result.onCommit : result.onWrite;
		if (row.event_type === "gate_pass") bucket.pass++;
		else bucket.fail++;
	}

	result.onWrite.total = result.onWrite.pass + result.onWrite.fail;
	result.onWrite.rate = result.onWrite.total > 0 ? result.onWrite.pass / result.onWrite.total : 1;
	result.onCommit.total = result.onCommit.pass + result.onCommit.fail;
	result.onCommit.rate =
		result.onCommit.total > 0 ? result.onCommit.pass / result.onCommit.total : 1;

	return result;
}

export function calculateQualityScore(store: Store, sessionId: string): QualityScore {
	const summary = getSessionSummary(store, sessionId);
	const gates = getGateBreakdown(store, sessionId);

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
		gates.onWrite.rate * 30 + gates.onCommit.rate * 20 + errorHitRate * 15 + convRate * 10 + 25, // base score
	);

	return {
		sessionScore: Math.min(100, Math.max(0, score)),
		breakdown: {
			gatePassRateWrite: {
				score: Math.round(gates.onWrite.rate * 100),
				pass: gates.onWrite.pass,
				total: gates.onWrite.total,
			},
			gatePassRateCommit: {
				score: Math.round(gates.onCommit.rate * 100),
				pass: gates.onCommit.pass,
				total: gates.onCommit.total,
			},
			errorResolutionHit: {
				score: Math.round(errorHitRate * 100),
				hit: errorHit,
				total: errorTotal,
			},
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
	const gates = getGateBreakdown(store, sessionId);
	const eh = summary.error_hit ?? 0;
	const em = summary.error_miss ?? 0;
	const et = eh + em;
	const eRate = et > 0 ? eh / et : 0;
	const cp = summary.convention_pass ?? 0;
	const cw = summary.convention_warn ?? 0;
	const ct = cp + cw;
	const cRate = ct > 0 ? cp / ct : 1;
	return Math.min(
		100,
		Math.max(
			0,
			Math.round(gates.onWrite.rate * 30 + gates.onCommit.rate * 20 + eRate * 15 + cRate * 10 + 25),
		),
	);
}

export function getLatestSessionId(store: Store, projectId: string): string | null {
	const row = store.db
		.prepare(`
			SELECT session_id FROM quality_events
			WHERE project_id = ? AND session_id NOT LIKE 'session-%'
			ORDER BY created_at DESC LIMIT 1
		`)
		.get(projectId) as { session_id: string } | null;
	return row?.session_id ?? null;
}

export function getRecentEvents(store: Store, sessionId: string, limit = 10): QualityEvent[] {
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
