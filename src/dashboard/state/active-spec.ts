/**
 * Resolve the active spec name and infer its current SDD phase from the
 * files present in `.qult/specs/<name>/`. Pure read-only — does not mutate.
 */

import { readdirSync } from "node:fs";
import { wavesDir } from "../../state/paths.ts";
import { getActiveSpec } from "../../state/spec.ts";
import type { ActiveSpec, SpecPhase } from "../types.ts";

/**
 * Determine the spec phase from on-disk artifacts.
 *
 *   - No requirements.md  → "requirements" (still drafting)
 *   - requirements only   → "requirements"
 *   - + design.md         → "design"
 *   - + tasks.md          → "tasks"
 *   - + waves/wave-*.md   → "implementation"
 */
export function inferPhase(info: {
	hasRequirements: boolean;
	hasDesign: boolean;
	hasTasks: boolean;
	wavesDirExists: boolean;
	specName: string;
}): SpecPhase {
	if (info.wavesDirExists) {
		try {
			const hasWaveFile = readdirSync(wavesDir(info.specName)).some((f) =>
				/^wave-\d+\.md$/.test(f),
			);
			if (hasWaveFile) return "implementation";
		} catch {
			/* dir vanished between calls — fall through */
		}
	}
	if (info.hasTasks) return "tasks";
	if (info.hasDesign) return "design";
	return "requirements";
}

/**
 * Read the current active spec. Returns null when none is present (clean
 * `main` branch, or post-`/qult:finish`). Multiple non-archived specs throw
 * via `getActiveSpec`; we surface that as null + caller logs the error.
 */
export function getActiveSpecForDashboard(): ActiveSpec | null {
	let info: ReturnType<typeof getActiveSpec>;
	try {
		info = getActiveSpec();
	} catch {
		return null;
	}
	if (info === null) return null;
	const phase = inferPhase({
		hasRequirements: info.hasRequirements,
		hasDesign: info.hasDesign,
		hasTasks: info.hasTasks,
		wavesDirExists: info.wavesDirExists,
		specName: info.name,
	});
	return { name: info.name, phase };
}
