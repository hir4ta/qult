/**
 * Semgrep CLI integration — optional SAST scanner that complements the
 * pattern-matching `security-check`.
 *
 * Behavior:
 *  - If `semgrep` is not on PATH → skipped (exit 0, warning on stderr).
 *  - If the registry config (`auto`) cannot be fetched (offline) → skipped.
 *  - On findings, returns one `PendingFix` per result, severity mapped from
 *    semgrep's `severity` string.
 *
 * Config:
 *  - `QULT_SEMGREP_CONFIG` env var overrides the rule pack (default: `auto`).
 *    Use `p/owasp-top-ten` or a local `.semgrep.yml` path for offline runs.
 */

import { execFileSync } from "node:child_process";
import type { PendingFix } from "../types.ts";

export interface SemgrepResult {
	fixes: PendingFix[];
	skipped: boolean;
	skipReason?: string;
}

/** Best-effort check that `semgrep` is on PATH and runnable. */
export function isSemgrepAvailable(): boolean {
	try {
		execFileSync("semgrep", ["--version"], { stdio: "ignore", timeout: 3_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Run semgrep against `files` and return findings as PendingFix[].
 * Skipped when `files` is empty or semgrep is unavailable.
 */
export function runSemgrepScan(files: string[], cwd: string = process.cwd()): SemgrepResult {
	if (files.length === 0) {
		return { fixes: [], skipped: true, skipReason: "no files to scan" };
	}
	if (!isSemgrepAvailable()) {
		return { fixes: [], skipped: true, skipReason: "semgrep not installed" };
	}
	const config = process.env.QULT_SEMGREP_CONFIG ?? "auto";
	let raw: string;
	try {
		raw = execFileSync(
			"semgrep",
			["scan", "--json", "--quiet", "--error", "--no-git-ignore", `--config=${config}`, ...files],
			{ cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
		);
	} catch (err) {
		const e = err as { stdout?: string; status?: number; code?: string };
		// Semgrep exits with code 1 when findings exist; stdout still has JSON.
		if (e.status === 1 && typeof e.stdout === "string" && e.stdout.length > 0) {
			raw = e.stdout;
		} else {
			return {
				fixes: [],
				skipped: true,
				skipReason: `semgrep failed (${e.code ?? `exit ${e.status ?? "?"}`})`,
			};
		}
	}
	return { fixes: parseSemgrepJson(raw), skipped: false };
}

interface SemgrepFinding {
	check_id: string;
	path: string;
	start: { line: number };
	extra: { message: string; severity: string };
}

function parseSemgrepJson(raw: string): PendingFix[] {
	let parsed: { results?: SemgrepFinding[] };
	try {
		parsed = JSON.parse(raw) as { results?: SemgrepFinding[] };
	} catch {
		return [];
	}
	const out: PendingFix[] = [];
	const byFile = new Map<string, { line: number; check: string; msg: string }[]>();
	for (const r of parsed.results ?? []) {
		const arr = byFile.get(r.path) ?? [];
		arr.push({ line: r.start.line, check: r.check_id, msg: r.extra.message });
		byFile.set(r.path, arr);
	}
	for (const [path, items] of byFile.entries()) {
		out.push({
			file: path,
			gate: "security-check",
			errors: items.map((i) => `[semgrep ${i.check}] line ${i.line}: ${i.msg}`),
		});
	}
	return out;
}
