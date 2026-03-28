import { readAllDaysArray, readDaily, today, writeDaily } from "./daily-file.ts";

const BASE = "metrics";

// Process-scoped cache (today's file only)
let _cache: MetricEntry[] | null = null;
let _dirty = false;
let _today: string | null = null;

// Module-scoped context: auto-injected into every metric entry
let _sessionId: string | undefined;
let _projectId: string | undefined;
let _branch: string | undefined;
let _user: string | undefined;

/** Set session/project/branch/user context for all subsequent metric entries. Called once per hook dispatch. */
export function setMetricsContext(ctx: {
	sessionId?: string;
	projectId?: string;
	branch?: string;
	user?: string;
}): void {
	_sessionId = ctx.sessionId;
	_projectId = ctx.projectId;
	_branch = ctx.branch;
	_user = ctx.user;
}

function withContext(entry: MetricEntry): MetricEntry {
	if (_sessionId) entry.session_id = _sessionId;
	if (_projectId) entry.project_id = _projectId;
	if (_branch) entry.branch = _branch;
	if (_user) entry.user = _user;
	return entry;
}

export interface MetricEntry {
	action: string; // "event:type" e.g. "pre-tool:deny"
	reason: string;
	at: string;
	detail?: Record<string, number>; // optional structured data (e.g. finding counts)
	session_id?: string; // Claude Code session identifier
	project_id?: string; // project directory name
	branch?: string; // git branch name
	user?: string; // git user or $USER
}

/** Read today's entries (process-scoped cache for writes). */
function readState(): MetricEntry[] {
	const d = today();
	if (_cache && _today === d) return _cache;
	_cache = readDaily<MetricEntry[]>(BASE, d, []);
	_today = d;
	_dirty = false;
	return _cache;
}

function writeState(entries: MetricEntry[]): void {
	_cache = entries;
	_dirty = true;
}

/** Flush cached metrics to disk if dirty. */
export function flush(): void {
	if (!_dirty || !_cache || !_today) return;
	try {
		writeDaily(BASE, _today, _cache);
	} catch {
		// fail-open
	}
	_dirty = false;
}

/** Reset cache (for tests). */
export function resetCache(): void {
	_cache = null;
	_dirty = false;
	_today = null;
}

/** Record a DENY/block/respond/respond-skipped/miss action with event name and reason. */
export function recordAction(
	event: string,
	type: "deny" | "block" | "respond" | "respond-skipped" | "miss" | "review-skipped",
	reason: string,
): void {
	const entries = readState();
	entries.push(withContext({ action: `${event}:${type}`, reason, at: new Date().toISOString() }));
	writeState(entries);
}

/** Record a gate execution outcome (pass/fail). */
export function recordGateOutcome(gate: string, passed: boolean): void {
	try {
		const entries = readState();
		entries.push(
			withContext({
				action: `gate:${passed ? "pass" : "fail"}`,
				reason: gate,
				at: new Date().toISOString(),
			}),
		);
		writeState(entries);
	} catch {
		// fail-open
	}
}

/** Record a DENY resolution (pending-fix cleared after DENY). */
export function recordResolution(event: string, reason: string): void {
	const entries = readState();
	entries.push(
		withContext({ action: `${event}:resolution`, reason, at: new Date().toISOString() }),
	);
	writeState(entries);
}

/** Record fix effort (number of edits to resolve a DENY). */
export function recordFixEffort(edits: number): void {
	try {
		const entries = readState();
		entries.push(
			withContext({
				action: "fix-effort:resolved",
				reason: `${edits} edits`,
				at: new Date().toISOString(),
				detail: { edits },
			}),
		);
		writeState(entries);
	} catch {
		// fail-open
	}
}

/** Read all recorded metrics across all days. */
export function readMetrics(): MetricEntry[] {
	return readAllDaysArray<MetricEntry>(BASE);
}

/** Record a first-pass outcome (file passed all gates on first write without fixes).
 * @param gate — optional gate name that caused the first failure (for gate-specific first-pass tracking)
 */
export function recordFirstPass(passed: boolean, gate?: string): void {
	try {
		const entries = readState();
		entries.push(
			withContext({
				action: `first-pass:${passed ? "clean" : "dirty"}`,
				reason: gate ?? "",
				at: new Date().toISOString(),
			}),
		);
		writeState(entries);
	} catch {
		// fail-open
	}
}

/** Record a review outcome (PASS or FAIL from qult-reviewer). */
export function recordReviewOutcome(passed: boolean, detail?: Record<string, number>): void {
	try {
		const entries = readState();
		entries.push(
			withContext({
				action: `review:${passed ? "pass" : "fail"}`,
				reason: "",
				at: new Date().toISOString(),
				detail,
			}),
		);
		writeState(entries);
	} catch {
		// fail-open
	}
}

/** Classify DENY as defensive (config-change hook protection) vs actionable (lint/typecheck/etc). */
const DEFENSIVE_DENY_RE = /hook|settings/i;

export interface MetricsSummary {
	deny: number;
	denyDefensive: number;
	denyActionable: number;
	block: number;
	respond: number;
	respondSkipped: number;
	resolution: number;
	denyResolutionRate: number;
	actionableDenyResolutionRate: number;
	gatePassRate: number;
	firstPassRate: number;
	firstPassTotal: number;
	firstPassRateRecent: number;
	reviewPassRate: number;
	reviewTotal: number;
	reviewMiss: number;
	reviewFindingsTotal: number;
	reviewFindingsBySeverity: { critical: number; high: number; medium: number; low: number };
	reviewAvgFindings: number;
	topReasons: { reason: string; count: number }[];
	topDenyReasons: { reason: string; count: number }[];
	topBlockReasons: { reason: string; count: number }[];
	topGateFailReasons: { reason: string; count: number }[];
	avgFixEffort: number;
	fixEffortTotal: number;
	denysPerCommit: number;
	permissionAllow: number;
	permissionDeny: number;
	planSuccessRate: number;
	peakConsecutiveErrors: number;
	gateFirstPassRates: { gate: string; rate: number; total: number }[];
}

/** Get summary: counts by action type + top reasons + outcome metrics.
 * @param peakErrors — peak consecutive error count from session-state (avoids circular import)
 * @param commitCount — total commits from gate-history (avoids circular import)
 */
export function getMetricsSummary(peakErrors = 0, commitCount = 0): MetricsSummary {
	const entries = readMetrics();
	let deny = 0;
	let denyDefensive = 0;
	let denyActionable = 0;
	let block = 0;
	let respond = 0;
	let respondSkipped = 0;
	let resolution = 0;
	let gatePass = 0;
	let gateFail = 0;
	let firstPassClean = 0;
	let firstPassDirty = 0;
	let reviewPass = 0;
	let reviewFail = 0;
	let reviewMiss = 0;
	let reviewFindingsTotal = 0;
	let fixEffortSum = 0;
	let fixEffortCount = 0;
	let permissionAllow = 0;
	let permissionDeny = 0;
	const reviewFindingsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
	const reasonCounts = new Map<string, number>();
	const denyReasonCounts = new Map<string, number>();
	const blockReasonCounts = new Map<string, number>();
	const gateFailReasonCounts = new Map<string, number>();
	const firstPassEntries: boolean[] = [];
	const gateFirstPass = new Map<string, { clean: number; total: number }>();

	for (const e of entries) {
		if (e.action.endsWith(":deny")) {
			deny++;
			if (DEFENSIVE_DENY_RE.test(e.reason)) {
				denyDefensive++;
			} else {
				denyActionable++;
				if (e.reason) denyReasonCounts.set(e.reason, (denyReasonCounts.get(e.reason) ?? 0) + 1);
			}
		} else if (e.action.endsWith(":block")) {
			block++;
			if (e.reason) blockReasonCounts.set(e.reason, (blockReasonCounts.get(e.reason) ?? 0) + 1);
		} else if (e.action.endsWith(":respond")) {
			respond++;
			// Track permission outcomes
			if (e.action === "permission-request:respond" && e.reason === "plan approved") {
				permissionAllow++;
			}
		} else if (e.action.endsWith(":respond-skipped")) {
			respondSkipped++;
		} else if (e.action.endsWith(":resolution")) {
			resolution++;
		} else if (e.action === "gate:pass") {
			gatePass++;
		} else if (e.action === "gate:fail") {
			gateFail++;
			if (e.reason)
				gateFailReasonCounts.set(e.reason, (gateFailReasonCounts.get(e.reason) ?? 0) + 1);
		} else if (e.action === "first-pass:clean") {
			firstPassClean++;
			firstPassEntries.push(true);
		} else if (e.action === "first-pass:dirty") {
			firstPassDirty++;
			firstPassEntries.push(false);
			// Track gate-specific first-pass failures
			if (e.reason) {
				const s = gateFirstPass.get(e.reason) ?? { clean: 0, total: 0 };
				s.total++;
				gateFirstPass.set(e.reason, s);
			}
		} else if (e.action === "review:pass") {
			reviewPass++;
		} else if (e.action === "review:fail") {
			reviewFail++;
		} else if (e.action === "review:miss") {
			reviewMiss++;
		} else if (e.action === "fix-effort:resolved" && e.detail) {
			fixEffortSum += e.detail.edits ?? 0;
			fixEffortCount++;
		}

		// Permission deny (counted via action suffix above)
		if (e.action === "permission-request:deny") {
			permissionDeny++;
		}

		// Aggregate review finding details
		if ((e.action === "review:pass" || e.action === "review:fail") && e.detail) {
			reviewFindingsTotal += e.detail.total ?? 0;
			reviewFindingsBySeverity.critical += e.detail.critical ?? 0;
			reviewFindingsBySeverity.high += e.detail.high ?? 0;
			reviewFindingsBySeverity.medium += e.detail.medium ?? 0;
			reviewFindingsBySeverity.low += e.detail.low ?? 0;
		}

		if (e.reason) {
			reasonCounts.set(e.reason, (reasonCounts.get(e.reason) ?? 0) + 1);
		}
	}

	const topN = (m: Map<string, number>, n = 5) =>
		[...m.entries()]
			.map(([reason, count]) => ({ reason, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, n);

	const gateTotal = gatePass + gateFail;
	const firstPassTotal = firstPassClean + firstPassDirty;
	const reviewTotal = reviewPass + reviewFail;

	// Recent first-pass rate (last 20 entries)
	const recentWindow = firstPassEntries.slice(-20);
	const recentClean = recentWindow.filter(Boolean).length;
	const firstPassRateRecent =
		recentWindow.length > 0 ? Math.round((recentClean / recentWindow.length) * 100) : 0;

	// DENYs per commit
	const denysPerCommit = commitCount > 0 ? Math.round((denyActionable / commitCount) * 10) / 10 : 0;

	const permissionTotal = permissionAllow + permissionDeny;

	return {
		deny,
		denyDefensive,
		denyActionable,
		block,
		respond,
		respondSkipped,
		resolution,
		denyResolutionRate: deny > 0 ? Math.min(100, Math.round((resolution / deny) * 100)) : 0,
		actionableDenyResolutionRate:
			denyActionable > 0 ? Math.min(100, Math.round((resolution / denyActionable) * 100)) : 0,
		gatePassRate: gateTotal > 0 ? Math.round((gatePass / gateTotal) * 100) : 0,
		firstPassRate: firstPassTotal > 0 ? Math.round((firstPassClean / firstPassTotal) * 100) : 0,
		firstPassTotal,
		firstPassRateRecent,
		reviewPassRate: reviewTotal > 0 ? Math.round((reviewPass / reviewTotal) * 100) : 0,
		reviewTotal,
		reviewMiss,
		reviewFindingsTotal,
		reviewFindingsBySeverity,
		reviewAvgFindings:
			reviewTotal > 0 ? Math.round((reviewFindingsTotal / reviewTotal) * 10) / 10 : 0,
		topReasons: topN(reasonCounts),
		topDenyReasons: topN(denyReasonCounts),
		topBlockReasons: topN(blockReasonCounts),
		topGateFailReasons: topN(gateFailReasonCounts),
		avgFixEffort: fixEffortCount > 0 ? Math.round((fixEffortSum / fixEffortCount) * 10) / 10 : 0,
		fixEffortTotal: fixEffortCount,
		denysPerCommit,
		permissionAllow,
		permissionDeny,
		planSuccessRate:
			permissionTotal > 0 ? Math.round((permissionAllow / permissionTotal) * 100) : 0,
		peakConsecutiveErrors: peakErrors,
		gateFirstPassRates:
			firstPassTotal > 0
				? [...gateFirstPass.entries()]
						.map(([gate, s]) => ({
							gate,
							rate: Math.round(((firstPassTotal - s.total) / firstPassTotal) * 100),
							total: s.total,
						}))
						.sort((a, b) => a.rate - b.rate)
				: [],
	};
}
