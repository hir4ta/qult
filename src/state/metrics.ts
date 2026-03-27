import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

const STATE_DIR = ".alfred/.state";
const FILE = "metrics.json";
const MAX_ENTRIES = 50;

interface MetricEntry {
	action: string; // "event:type" e.g. "pre-tool:deny"
	reason: string;
	at: string;
}

function filePath(): string {
	return join(process.cwd(), STATE_DIR, FILE);
}

function readState(): MetricEntry[] {
	try {
		const path = filePath();
		if (!existsSync(path)) return [];
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return [];
	}
}

function writeState(entries: MetricEntry[]): void {
	try {
		atomicWriteJson(filePath(), entries);
	} catch {
		// fail-open
	}
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

/** Read all recorded metrics (up to 50). */
export function readMetrics(): MetricEntry[] {
	return readState();
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

/** Record a review outcome (PASS or FAIL from alfred-reviewer). */
export function recordReviewOutcome(passed: boolean): void {
	try {
		const entries = readState();
		entries.push({
			action: `review:${passed ? "pass" : "fail"}`,
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
		topReasons,
	};
}
