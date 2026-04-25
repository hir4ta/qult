/**
 * `qult check` — read-only snapshot of project state.
 *
 * Default: prints test_passed_at / review_completed_at / pending_fixes count
 * and active spec summary. With `--detect`: also runs the 5 Tier 1 detectors
 * and exits 1 if any HIGH-severity findings.
 *
 * Never writes to `.qult/state/`.
 */

import { execSync } from "node:child_process";
import { runAllDetectors } from "../../detector/index.ts";
import { readCurrent, readPendingFixes } from "../../state/json-state.ts";
import { getActiveSpec } from "../../state/spec.ts";

export interface CheckOptions {
	detect?: boolean;
	json?: boolean;
}

export async function runCheck(opts: CheckOptions): Promise<number> {
	const cwd = process.cwd();
	const cur = readCurrent();
	const pending = readPendingFixes();
	const active = getActiveSpec();

	let detectorOutcome: { exitCode: 0 | 1; high: number; results: unknown[] } | null = null;
	if (opts.detect) {
		const files = listChangedFiles(cwd);
		const results = await runAllDetectors(files, { cwd });
		const high = results.reduce(
			(n, r) => n + r.fixes.filter((f) => f.errors && f.errors.length > 0).length,
			0,
		);
		detectorOutcome = { exitCode: high > 0 ? 1 : 0, high, results };
	}

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					active_spec: active
						? {
								name: active.name,
								has_requirements: active.hasRequirements,
								has_design: active.hasDesign,
								has_tasks: active.hasTasks,
							}
						: null,
					test_passed_at: cur.test_passed_at,
					review_completed_at: cur.review_completed_at,
					pending_fixes: pending.fixes.length,
					detectors: detectorOutcome,
				},
				null,
				2,
			)}\n`,
		);
	} else {
		process.stdout.write("qult check\n");
		process.stdout.write(`  active spec: ${active ? active.name : "none"}\n`);
		process.stdout.write(`  test_passed_at: ${cur.test_passed_at ?? "—"}\n`);
		process.stdout.write(`  review_completed_at: ${cur.review_completed_at ?? "—"}\n`);
		process.stdout.write(`  pending_fixes: ${pending.fixes.length}\n`);
		if (detectorOutcome) {
			process.stdout.write(`  detector HIGH findings: ${detectorOutcome.high}\n`);
		}
	}

	return detectorOutcome?.exitCode ?? 0;
}

/** Use git to enumerate uncommitted source files; fall back to empty list. */
function listChangedFiles(cwd: string): string[] {
	try {
		const out = execSync("git diff --name-only HEAD", { cwd, encoding: "utf8" });
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.map((l) => `${cwd}/${l}`);
	} catch {
		return [];
	}
}
