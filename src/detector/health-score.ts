import { existsSync } from "node:fs";
import type { PendingFix } from "../types.ts";
import { detectDeadImports } from "./dead-import-check.ts";
import { detectExportBreakingChanges } from "./export-check.ts";
import { detectSecurityPatterns } from "./security-check.ts";
import { analyzeTestQuality } from "./test-quality-check.ts";

interface HealthResult {
	score: number;
	breakdown: Record<string, number>;
}

/** Per-finding penalty weights */
const WEIGHTS: Record<string, number> = {
	security: -2,
	export_breaking: -2,
	dead_imports: -1,
	test_quality: -1.5,
};

const DEFAULT_WEIGHT = -1;

function countFindings(fixes: PendingFix[]): number {
	return fixes.reduce((sum, f) => sum + f.errors.length, 0);
}

/** Compute a 0-10 health score for a file by aggregating Tier 1 detector findings. */
export function computeFileHealthScore(file: string): HealthResult {
	if (!existsSync(file)) {
		return { score: 10, breakdown: {} };
	}

	const breakdown: Record<string, number> = {};

	try {
		const securityFixes = detectSecurityPatterns(file);
		const count = countFindings(securityFixes);
		if (count > 0) breakdown.security = (WEIGHTS.security ?? DEFAULT_WEIGHT) * count;
	} catch {
		/* fail-open */
	}

	try {
		const deadImports = detectDeadImports(file);
		if (deadImports.length > 0)
			breakdown.dead_imports = (WEIGHTS.dead_imports ?? DEFAULT_WEIGHT) * deadImports.length;
	} catch {
		/* fail-open */
	}

	try {
		const exportFixes = detectExportBreakingChanges(file);
		const count = countFindings(exportFixes);
		if (count > 0) breakdown.export_breaking = (WEIGHTS.export_breaking ?? DEFAULT_WEIGHT) * count;
	} catch {
		/* fail-open */
	}

	try {
		const tqResult = analyzeTestQuality(file);
		if (tqResult !== null && tqResult.smells.length > 0)
			breakdown.test_quality = (WEIGHTS.test_quality ?? DEFAULT_WEIGHT) * tqResult.smells.length;
	} catch {
		/* fail-open */
	}

	const totalPenalty = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
	const score = Math.max(0, Math.round((10 + totalPenalty) * 10) / 10);

	return { score, breakdown };
}
