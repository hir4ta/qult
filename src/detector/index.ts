/**
 * Detector orchestrator: runs the 5 Tier 1 detectors against a set of files
 * and aggregates results, with auto-skip for network-bound detectors when
 * the network is unreachable (air-gapped runs).
 *
 * Detector functions themselves stay pure — the network gate lives here so
 * unit tests can exercise each detector deterministically.
 */

import { loadConfig } from "../config.ts";
import type { PendingFix } from "../types.ts";
import { scanDependencyVulns } from "./dep-vuln-check.ts";
import { detectExportBreakingChanges } from "./export-check.ts";
import { checkInstalledPackages } from "./hallucinated-package-check.ts";
import { isNetworkAvailable } from "./network.ts";
import { detectSecurityPatterns } from "./security-check.ts";
import { runSemgrepScan } from "./semgrep.ts";
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
	/**
	 * Optional progress sink. Called with `start` before each detector runs
	 * and `complete` immediately after it finishes (or is skipped). Lets the
	 * dashboard's `qult check --detect` UI render live spinners / badges.
	 */
	onProgress?: (event: DetectorProgressEvent) => void;
	/**
	 * Suppress the `[qult] detector ... skipped` stderr lines. Required
	 * when a TUI (Ink) is on stdout: stray stderr output between Ink's
	 * frame writes throws off its cursor-position math and the previous
	 * frame stops being overwritten.
	 */
	silent?: boolean;
}

export interface DetectorProgressEvent {
	kind: "start" | "complete";
	detector: DetectorName;
	result?: DetectorResult;
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
	const onProgress = opts.onProgress;

	const runOne = async (
		name: DetectorName,
		fn: () => Promise<DetectorResult> | DetectorResult,
	): Promise<void> => {
		onProgress?.({ kind: "start", detector: name });
		const result = await fn();
		results.push(result);
		onProgress?.({ kind: "complete", detector: name, result });
	};

	await runOne("security-check", () => {
		const securityFixes: PendingFix[] = files.flatMap((f) => detectSecurityPatterns(f));
		if (loadConfig().security.enable_semgrep) {
			const semgrep = runSemgrepScan(files, cwd);
			if (semgrep.skipped) {
				if (!opts.silent) {
					process.stderr.write(`[qult] semgrep skipped: ${semgrep.skipReason}\n`);
				}
			} else {
				securityFixes.push(...semgrep.fixes);
			}
		}
		return { detector: "security-check", fixes: securityFixes, skipped: false };
	});

	await runOne("dep-vuln-check", () => {
		if (!networkOk) {
			return {
				detector: "dep-vuln-check",
				fixes: [],
				skipped: true,
				skipReason: "network unavailable",
			};
		}
		return { detector: "dep-vuln-check", fixes: scanDependencyVulns(cwd), skipped: false };
	});

	await runOne("hallucinated-package-check", async () => {
		if (!opts.hallucinatedPackages) {
			return {
				detector: "hallucinated-package-check",
				fixes: [],
				skipped: true,
				skipReason: "no install command provided",
			};
		}
		if (!networkOk) {
			return {
				detector: "hallucinated-package-check",
				fixes: [],
				skipped: true,
				skipReason: "network unavailable",
			};
		}
		const { pm, packages } = opts.hallucinatedPackages;
		return {
			detector: "hallucinated-package-check",
			fixes: await checkInstalledPackages(pm, packages),
			skipped: false,
		};
	});

	await runOne("test-quality-check", () => {
		const testSmells: PendingFix[] = [];
		for (const f of files) {
			const analysis = analyzeTestQuality(f);
			if (analysis) testSmells.push(...getBlockingTestSmells(f, analysis));
		}
		return { detector: "test-quality-check", fixes: testSmells, skipped: false };
	});

	await runOne("export-check", () => ({
		detector: "export-check",
		fixes: files.flatMap((f) => detectExportBreakingChanges(f)),
		skipped: false,
	}));

	if (!opts.silent) {
		const networkSkipped = results.filter((r) => r.skipped && NETWORK_DETECTORS.has(r.detector));
		for (const r of networkSkipped) {
			process.stderr.write(`[qult] detector ${r.detector} skipped: ${r.skipReason}\n`);
		}
	}

	return results;
}
