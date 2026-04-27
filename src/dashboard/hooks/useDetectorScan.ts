/**
 * Run all Tier-1 detectors once on dashboard mount and expose per-detector
 * progress / status as React state. Results live in memory only — we never
 * write to `.qult/state/pending-fixes.json`, so the dashboard's auto-scan
 * doesn't disturb the explicit `qult check --detect` workflow that the
 * pre-commit gate relies on.
 *
 * Behaviour:
 *   - On mount, every detector starts in `running` state.
 *   - As each detector completes, its row flips to `pass` / `warn` /
 *     `fail` / `skipped` based on the result.
 *   - Network-bound detectors gracefully fall through to `skipped` when
 *     offline (handled by `runAllDetectors`).
 *
 * The hook is intentionally fire-once: scan refreshes when the user
 * relaunches the dashboard, which matches the "minimum explicit commands"
 * UX the project is targeting.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { useEffect, useState } from "react";
import {
	type DetectorName,
	type DetectorProgressEvent,
	type DetectorResult,
	runAllDetectors,
} from "../../detector/index.ts";
import {
	ALL_DETECTOR_IDS,
	type DetectorId,
	type DetectorStatus,
	type DetectorSummary,
} from "../types.ts";

/**
 * The dashboard's auto-scan defaults to **offline** to avoid silently
 * leaking package names to npm registry / OSV when the user just opens the
 * monitor. Set `QULT_DASHBOARD_NETWORK=1` to opt back in (e.g. inside CI
 * or on a personal box where the egress is acceptable).
 */
const NETWORK_ALLOWED = process.env.QULT_DASHBOARD_NETWORK === "1";

const NAME_TO_ID: Record<DetectorName, DetectorId> = {
	"security-check": "security",
	"dep-vuln-check": "dep-vuln",
	"hallucinated-package-check": "hallucinated-package",
	"test-quality-check": "test-quality",
	"export-check": "export",
};

function listChangedFiles(cwd: string): string[] {
	try {
		const out = execSync("git diff --name-only HEAD", { cwd, encoding: "utf8" });
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.map((l) => join(cwd, l));
	} catch {
		return [];
	}
}

function classify(result: DetectorResult, filesScanned: number): DetectorStatus {
	if (result.skipped) return "skipped";
	if (result.fixes.length === 0) {
		// Pure file-based detectors: an empty file list means we didn't
		// actually look at anything, which is materially different from
		// "passed". The orchestrator-only detectors (dep-vuln, hallucinated)
		// don't take per-file input — for those a 0-file pass is real.
		return filesScanned > 0 ? "pass" : "idle";
	}
	if (result.fixes.some((f) => (f.errors?.length ?? 0) > 0)) return "fail";
	return "warn";
}

const FILE_BASED_DETECTORS = new Set(["security-check", "test-quality-check", "export-check"]);

export interface DetectorScanState {
	/** Per-detector summary keyed by DetectorId. */
	detectors: DetectorSummary[];
	/** True until the scan finishes; lets the UI show a global hint. */
	scanning: boolean;
}

export function useDetectorScan(): DetectorScanState {
	const [detectors, setDetectors] = useState<DetectorSummary[]>(() =>
		ALL_DETECTOR_IDS.map((id) => ({
			id,
			status: "running" as DetectorStatus,
			pendingFixes: 0,
			filesScanned: null,
			lastRunAt: null,
		})),
	);
	const [scanning, setScanning] = useState(true);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const cwd = process.cwd();
			const files = listChangedFiles(cwd);
			const onProgress = (e: DetectorProgressEvent): void => {
				if (cancelled) return;
				if (e.kind === "start") return;
				const result = e.result;
				if (!result) return;
				const id = NAME_TO_ID[e.detector];
				const isFileBased = FILE_BASED_DETECTORS.has(e.detector);
				const filesScanned = isFileBased ? files.length : 0;
				setDetectors((prev) =>
					prev.map((d) =>
						d.id === id
							? {
									...d,
									status: classify(result, filesScanned),
									pendingFixes: result.fixes.length,
									filesScanned: isFileBased ? files.length : null,
									lastRunAt: Date.now(),
								}
							: d,
					),
				);
			};
			try {
				await runAllDetectors(files, {
					cwd,
					onProgress,
					offline: !NETWORK_ALLOWED,
					silent: true,
				});
			} catch {
				if (cancelled) return;
				// On crash, leave any not-yet-completed rows at `running` →
				// flip them to `skipped` so the UI doesn't sit forever.
				setDetectors((prev) =>
					prev.map((d) => (d.status === "running" ? { ...d, status: "skipped" } : d)),
				);
			} finally {
				if (!cancelled) setScanning(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	return { detectors, scanning };
}
