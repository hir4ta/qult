/**
 * Detector orchestrator: runs the 5 Tier 1 detectors against a set of files
 * and aggregates results, with auto-skip for network-bound detectors when
 * the network is unreachable (air-gapped runs).
 *
 * Detector functions themselves stay pure — the network gate lives here so
 * unit tests can exercise each detector deterministically.
 */

import type { PendingFix } from "../types.ts";
import { scanDependencyVulns } from "./dep-vuln-check.ts";
import { detectExportBreakingChanges } from "./export-check.ts";
import { checkInstalledPackages } from "./hallucinated-package-check.ts";
import { isNetworkAvailable } from "./network.ts";
import { detectSecurityPatterns } from "./security-check.ts";
import { analyzeTestQuality, getBlockingTestSmells } from "./test-quality-check.ts";

export type DetectorName =
	| "security-check"
	| "dep-vuln-check"
	| "hallucinated-package-check"
	| "test-quality-check"
	| "export-check";

export interface DetectorResult {
	detector: DetectorName;
	fixes: PendingFix[];
	skipped: boolean;
	skipReason?: string;
}

export interface DetectorOptions {
	/** Working directory used by detectors that scan the project (cwd-based). */
	cwd?: string;
	/**
	 * Hallucinated-package-check input: package manager + package list.
	 * Skipped entirely when omitted (the detector has no per-file mode).
	 */
	hallucinatedPackages?: { pm: string; packages: string[] };
	/** Skip detectors that require network access without running probe. */
	offline?: boolean;
}

const NETWORK_DETECTORS: ReadonlySet<DetectorName> = new Set([
	"dep-vuln-check",
	"hallucinated-package-check",
]);

/**
 * Run all Tier 1 detectors against `files` and return per-detector results.
 *
 * Network-bound detectors (`dep-vuln-check`, `hallucinated-package-check`) are
 * skipped with `skipped: true, skipReason: "network unavailable"` when the
 * registry ping probe fails or `opts.offline` is set.
 */
export async function runAllDetectors(
	files: string[],
	opts: DetectorOptions = {},
): Promise<DetectorResult[]> {
	const cwd = opts.cwd ?? process.cwd();
	const networkOk = opts.offline ? false : await isNetworkAvailable();

	const results: DetectorResult[] = [];

	results.push({
		detector: "security-check",
		fixes: files.flatMap((f) => detectSecurityPatterns(f)),
		skipped: false,
	});

	if (!networkOk) {
		results.push({
			detector: "dep-vuln-check",
			fixes: [],
			skipped: true,
			skipReason: "network unavailable",
		});
	} else {
		results.push({
			detector: "dep-vuln-check",
			fixes: scanDependencyVulns(cwd),
			skipped: false,
		});
	}

	if (!opts.hallucinatedPackages) {
		results.push({
			detector: "hallucinated-package-check",
			fixes: [],
			skipped: true,
			skipReason: "no install command provided",
		});
	} else if (!networkOk) {
		results.push({
			detector: "hallucinated-package-check",
			fixes: [],
			skipped: true,
			skipReason: "network unavailable",
		});
	} else {
		const { pm, packages } = opts.hallucinatedPackages;
		results.push({
			detector: "hallucinated-package-check",
			fixes: await checkInstalledPackages(pm, packages),
			skipped: false,
		});
	}

	const testSmells: PendingFix[] = [];
	for (const f of files) {
		const analysis = analyzeTestQuality(f);
		if (analysis) testSmells.push(...getBlockingTestSmells(f, analysis));
	}
	results.push({
		detector: "test-quality-check",
		fixes: testSmells,
		skipped: false,
	});

	results.push({
		detector: "export-check",
		fixes: files.flatMap((f) => detectExportBreakingChanges(f)),
		skipped: false,
	});

	const networkSkipped = results.filter((r) => r.skipped && NETWORK_DETECTORS.has(r.detector));
	for (const r of networkSkipped) {
		process.stderr.write(`[qult] detector ${r.detector} skipped: ${r.skipReason}\n`);
	}

	return results;
}
