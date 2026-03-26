/**
 * Proactive context injection — file risk scoring + co-change analysis.
 *
 * Cached at SessionStart, injected at PreToolUse for high-risk files.
 * Research: Microsoft (code churn predicts defects), Aider (repo map).
 */
import { execFileSync } from "node:child_process";

export interface FileRiskScore {
	file: string;
	score: number; // 0-100
	reasons: string[];
}

export interface CoChangePair {
	file: string;
	partner: string;
	count: number;
}

/**
 * Analyze file risk from git history (churn + bug-fix frequency).
 * Runs git log, should complete in <3 seconds.
 */
export function analyzeFileRisks(cwd: string): FileRiskScore[] {
	try {
		const raw = execFileSync("git", ["log", "--format=", "--name-only", "--since=6 months ago"], {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
		});

		const fixRaw = execFileSync(
			"git",
			[
				"log",
				"--format=",
				"--name-only",
				"--since=6 months ago",
				"--grep=^fix",
				"--regexp-ignore-case",
			],
			{ cwd, encoding: "utf-8", timeout: 3000 },
		);

		// Count per-file churn
		const churnMap = new Map<string, number>();
		for (const line of raw.split("\n")) {
			const f = line.trim();
			if (f) churnMap.set(f, (churnMap.get(f) ?? 0) + 1);
		}

		// Count per-file bug-fix churn
		const fixMap = new Map<string, number>();
		for (const line of fixRaw.split("\n")) {
			const f = line.trim();
			if (f) fixMap.set(f, (fixMap.get(f) ?? 0) + 1);
		}

		const results: FileRiskScore[] = [];
		for (const [file, churn] of churnMap) {
			const fixes = fixMap.get(file) ?? 0;
			const churnScore = Math.min(churn / 20, 1) * 35;
			const fixScore = Math.min(fixes / 5, 1) * 50;
			const score = Math.round(churnScore + fixScore + 15); // 15 base
			if (score > 50) {
				const reasons: string[] = [];
				if (churn > 10) reasons.push(`${churn} changes`);
				if (fixes > 2) reasons.push(`${fixes} bug-fixes`);
				results.push({ file, score, reasons });
			}
		}

		return results.sort((a, b) => b.score - a.score).slice(0, 50);
	} catch {
		return [];
	}
}

/**
 * Analyze co-change patterns from git history.
 * Files frequently changed together in the same commit.
 */
export function analyzeCoChanges(cwd: string): CoChangePair[] {
	try {
		const raw = execFileSync("git", ["log", "--format=%n", "--name-only", "-200"], {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
		});

		// Parse commit-grouped files (separated by blank lines)
		const commits: string[][] = [];
		let current: string[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) {
				if (current.length > 1) commits.push(current);
				current = [];
			} else {
				current.push(trimmed);
			}
		}
		if (current.length > 1) commits.push(current);

		// Count co-occurrence pairs
		const pairMap = new Map<string, number>();
		for (const files of commits) {
			// Limit to prevent O(n^2) explosion on large commits
			const limited = files.slice(0, 10);
			for (let i = 0; i < limited.length; i++) {
				for (let j = i + 1; j < limited.length; j++) {
					const key = [limited[i]!, limited[j]!].sort().join("|");
					pairMap.set(key, (pairMap.get(key) ?? 0) + 1);
				}
			}
		}

		const results: CoChangePair[] = [];
		for (const [key, count] of pairMap) {
			if (count >= 3) {
				const [file, partner] = key.split("|") as [string, string];
				results.push({ file, partner, count });
			}
		}

		return results.sort((a, b) => b.count - a.count).slice(0, 100);
	} catch {
		return [];
	}
}

export function getRiskWarning(filePath: string, scores: FileRiskScore[]): string | null {
	const match = scores.find((s) => filePath.endsWith(s.file) || filePath.includes(s.file));
	if (!match || match.score <= 70) return null;
	return `High-risk file (score ${match.score}/100): ${match.reasons.join(", ")}. Extra care recommended.`;
}

export function getCoChangeHints(filePath: string, pairs: CoChangePair[]): string[] {
	const related = pairs
		.filter(
			(p) =>
				filePath.endsWith(p.file) ||
				filePath.endsWith(p.partner) ||
				filePath.includes(p.file) ||
				filePath.includes(p.partner),
		)
		.map((p) => (filePath.includes(p.file) ? p.partner : p.file))
		.slice(0, 3);
	return [...new Set(related)];
}
