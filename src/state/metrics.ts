import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

const STATE_DIR = ".qult/.state";
const FILE = "metrics.json";
const MAX_ENTRIES = 500;

// Process-scoped cache
let _cache: MetricEntry[] | null = null;
let _dirty = false;

interface MetricEntry {
	action: string; // "event:type" e.g. "pre-tool:deny"
	reason: string;
	at: string;
	detail?: Record<string, number>; // optional structured data (e.g. finding counts)
}

function filePath(): string {
	return join(process.cwd(), STATE_DIR, FILE);
}

function readState(): MetricEntry[] {
	if (_cache) return _cache;
	try {
		const path = filePath();
		if (!existsSync(path)) {
			_cache = [];
			return _cache;
		}
		_cache = JSON.parse(readFileSync(path, "utf-8"));
		return _cache!;
	} catch {
		_cache = [];
		return _cache;
	}
}

function writeState(entries: MetricEntry[]): void {
	_cache = entries;
	_dirty = true;
}

/** Flush cached metrics to disk if dirty. */
export function flush(): void {
	if (!_dirty || !_cache) return;
	try {
		atomicWriteJson(filePath(), _cache);
	} catch {
		// fail-open
	}
	_dirty = false;
}

/** Reset cache (for tests). */
export function resetCache(): void {
	_cache = null;
	_dirty = false;
}

/** Record a DENY/block/respond/respond-skipped/miss action with event name and reason. */
export function recordAction(
	event: string,
	type: "deny" | "block" | "respond" | "respond-skipped" | "miss" | "review-skipped",
	reason: string,
): void {
	const entries = readState();
	entries.push({ action: `${event}:${type}`, reason, at: new Date().toISOString() });
	if (entries.length > MAX_ENTRIES) {
		entries.splice(0, entries.length - MAX_ENTRIES);
	}
	writeState(entries);
}

/** Record a gate execution outcome (pass/fail). */
export function recordGateOutcome(gate: string, passed: boolean): void {
	try {
		const entries = readState();
		entries.push({
			action: `gate:${passed ? "pass" : "fail"}`,
			reason: gate,
			at: new Date().toISOString(),
		});
		if (entries.length > MAX_ENTRIES) {
			entries.splice(0, entries.length - MAX_ENTRIES);
		}
		writeState(entries);
	} catch {
		// fail-open
	}
}

/** Record a DENY resolution (pending-fix cleared after DENY). */
export function recordResolution(event: string, reason: string): void {
	const entries = readState();
	entries.push({ action: `${event}:resolution`, reason, at: new Date().toISOString() });
	if (entries.length > MAX_ENTRIES) {
		entries.splice(0, entries.length - MAX_ENTRIES);
	}
	writeState(entries);
}

/** Read all recorded metrics (up to 500). Returns a copy to prevent external mutation of cache. */
export function readMetrics(): MetricEntry[] {
	return [...readState()];
}

/** Record a first-pass outcome (file passed all gates on first write without fixes). */
export function recordFirstPass(passed: boolean): void {
	try {
		const entries = readState();
		entries.push({
			action: `first-pass:${passed ? "clean" : "dirty"}`,
			reason: "",
			at: new Date().toISOString(),
		});
		if (entries.length > MAX_ENTRIES) {
			entries.splice(0, entries.length - MAX_ENTRIES);
		}
		writeState(entries);
	} catch {
		// fail-open
	}
}

/** Record a review outcome (PASS or FAIL from qult-reviewer). */
export function recordReviewOutcome(passed: boolean, detail?: Record<string, number>): void {
	try {
		const entries = readState();
		entries.push({
			action: `review:${passed ? "pass" : "fail"}`,
			reason: "",
			at: new Date().toISOString(),
			detail,
		});
		if (entries.length > MAX_ENTRIES) {
			entries.splice(0, entries.length - MAX_ENTRIES);
		}
		writeState(entries);
	} catch {
		// fail-open
	}
}

/** Get summary: counts by action type + top reasons + outcome metrics. */
export function getMetricsSummary(): {
	deny: number;
	block: number;
	respond: number;
	respondSkipped: number;
	resolution: number;
	denyResolutionRate: number;
	gatePassRate: number;
	firstPassRate: number;
	firstPassTotal: number;
	reviewPassRate: number;
	reviewTotal: number;
	reviewMiss: number;
	reviewFindingsTotal: number;
	reviewFindingsBySeverity: { critical: number; high: number; medium: number; low: number };
	reviewAvgFindings: number;
	topReasons: { reason: string; count: number }[];
} {
	const entries = readState();
	let deny = 0;
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
	const reviewFindingsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
	const reasonCounts = new Map<string, number>();

	for (const e of entries) {
		if (e.action.endsWith(":deny")) deny++;
		else if (e.action.endsWith(":block")) block++;
		else if (e.action.endsWith(":respond")) respond++;
		else if (e.action.endsWith(":respond-skipped")) respondSkipped++;
		else if (e.action.endsWith(":resolution")) resolution++;
		else if (e.action === "gate:pass") gatePass++;
		else if (e.action === "gate:fail") gateFail++;
		else if (e.action === "first-pass:clean") firstPassClean++;
		else if (e.action === "first-pass:dirty") firstPassDirty++;
		else if (e.action === "review:pass") reviewPass++;
		else if (e.action === "review:fail") reviewFail++;
		else if (e.action === "review:miss") reviewMiss++;

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

	const topReasons = [...reasonCounts.entries()]
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);

	const gateTotal = gatePass + gateFail;
	const firstPassTotal = firstPassClean + firstPassDirty;
	const reviewTotal = reviewPass + reviewFail;

	return {
		deny,
		block,
		respond,
		respondSkipped,
		resolution,
		denyResolutionRate: deny > 0 ? Math.min(100, Math.round((resolution / deny) * 100)) : 0,
		gatePassRate: gateTotal > 0 ? Math.round((gatePass / gateTotal) * 100) : 0,
		firstPassRate: firstPassTotal > 0 ? Math.round((firstPassClean / firstPassTotal) * 100) : 0,
		firstPassTotal,
		reviewPassRate: reviewTotal > 0 ? Math.round((reviewPass / reviewTotal) * 100) : 0,
		reviewTotal,
		reviewMiss,
		reviewFindingsTotal,
		reviewFindingsBySeverity,
		reviewAvgFindings:
			reviewTotal > 0 ? Math.round((reviewFindingsTotal / reviewTotal) * 10) / 10 : 0,
		topReasons,
	};
}
