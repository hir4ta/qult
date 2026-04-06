import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

export interface SessionMetrics {
	session_id: string;
	timestamp: string;
	gate_failures: number;
	security_warnings: number;
	review_score: number | null;
	files_changed: number;
}

const STATE_DIR = ".qult/.state";
const METRICS_FILE = "metrics-history.json";
const MAX_ENTRIES = 50;

/** Record session metrics to history. Fail-open. */
export function recordSessionMetrics(cwd: string, metrics: SessionMetrics): void {
	try {
		const metricsPath = join(cwd, STATE_DIR, METRICS_FILE);
		let history = readMetricsHistory(cwd);
		history.push(metrics);
		if (history.length > MAX_ENTRIES) {
			history = history.slice(-MAX_ENTRIES);
		}
		atomicWriteJson(metricsPath, history);
	} catch {
		/* fail-open */
	}
}

/** Read metrics history. Returns empty array on any error. */
export function readMetricsHistory(cwd: string): SessionMetrics[] {
	try {
		const metricsPath = join(cwd, STATE_DIR, METRICS_FILE);
		if (!existsSync(metricsPath)) return [];
		const parsed = JSON.parse(readFileSync(metricsPath, "utf-8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Detect recurring patterns across last 5 sessions. Emits stderr warnings. Fail-open. */
export function detectRecurringPatterns(cwd: string): void {
	try {
		const history = readMetricsHistory(cwd);
		if (history.length < 5) return;

		const recent = history.slice(-5);

		// Check gate failure frequency with trend (must be increasing or sustained)
		const gateFailSessions = recent.filter((s) => s.gate_failures > 0).length;
		if (gateFailSessions >= 4) {
			const totalGateFailures = recent.reduce((sum, s) => sum + s.gate_failures, 0);
			const avgFailures = (totalGateFailures / recent.length).toFixed(1);
			process.stderr.write(
				`[qult] Pattern: gate failures in ${gateFailSessions}/5 recent sessions (avg ${avgFailures}/session). Review toolchain or add .claude/rules/ entries.\n`,
			);
		}

		// Check security warning frequency with detail
		const secWarnSessions = recent.filter((s) => s.security_warnings > 0).length;
		if (secWarnSessions >= 4) {
			const totalSecWarnings = recent.reduce((sum, s) => sum + s.security_warnings, 0);
			process.stderr.write(
				`[qult] Pattern: ${totalSecWarnings} security warnings across ${secWarnSessions}/5 recent sessions. Consider adding .claude/rules/ for security patterns.\n`,
			);
		}
	} catch {
		/* fail-open */
	}
}
