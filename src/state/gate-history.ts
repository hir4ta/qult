import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

const STATE_DIR = ".alfred/.state";
const FILE = "gate-history.json";
const MAX_ENTRIES = 50;

interface GateEntry {
	gate: string;
	passed: boolean;
	error?: string;
	at: string;
}

interface CommitEntry {
	at: string;
}

interface HistoryState {
	gates: GateEntry[];
	commits: CommitEntry[];
}

function filePath(): string {
	return join(process.cwd(), STATE_DIR, FILE);
}

function readHistory(): HistoryState {
	try {
		const path = filePath();
		if (!existsSync(path)) return { gates: [], commits: [] };
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return { gates: [], commits: [] };
	}
}

function writeHistory(state: HistoryState): void {
	try {
		atomicWriteJson(filePath(), state);
	} catch {
		// fail-open
	}
}

/** Record a gate execution result. */
export function recordGateResult(gate: string, passed: boolean, error?: string): void {
	const history = readHistory();
	history.gates.push({ gate, passed, error, at: new Date().toISOString() });
	if (history.gates.length > MAX_ENTRIES) {
		history.gates = history.gates.slice(-MAX_ENTRIES);
	}
	writeHistory(history);
}

/** Get top N most frequent gate errors. */
export function getTopErrors(n: number): { gate: string; error: string; count: number }[] {
	const history = readHistory();
	const errors = history.gates.filter((e) => !e.passed && e.error);

	const counts = new Map<string, { gate: string; error: string; count: number }>();
	for (const e of errors) {
		const key = `${e.gate}:${e.error}`;
		const existing = counts.get(key);
		if (existing) {
			existing.count++;
		} else {
			counts.set(key, { gate: e.gate, error: e.error!, count: 1 });
		}
	}

	return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

/** Record a git commit timestamp. */
export function recordCommit(): void {
	const history = readHistory();
	history.commits.push({ at: new Date().toISOString() });
	if (history.commits.length > MAX_ENTRIES) {
		history.commits = history.commits.slice(-MAX_ENTRIES);
	}
	writeHistory(history);
}

/** Get average commit interval in minutes. Returns null if < 2 commits. */
export function getCommitStats(): { avgMinutes: number; count: number } | null {
	const history = readHistory();
	if (history.commits.length < 2) return null;

	const times = history.commits.map((c) => new Date(c.at).getTime()).sort((a, b) => a - b);
	let totalInterval = 0;
	for (let i = 1; i < times.length; i++) {
		totalInterval += times[i]! - times[i - 1]!;
	}
	const avgMs = totalInterval / (times.length - 1);
	return { avgMinutes: avgMs / 60_000, count: history.commits.length };
}
