import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";

const REVIEW_GATE_PATTERN = /review/i;

/** PermissionRequest: Validate plan structure on ExitPlanMode */
export default async function permissionRequest(ev: HookEvent): Promise<void> {
	if (ev.tool?.name !== "ExitPlanMode") return;

	const planContent = findLatestPlan();
	if (!planContent) return; // fail-open

	if (!REVIEW_GATE_PATTERN.test(planContent)) {
		deny(
			"Plan is missing Review Gates. Add a '## Review Gates' section with Design Review, Phase Review, and Final Review checkboxes.",
		);
	}
}

function findLatestPlan(): string | null {
	try {
		const planDir = join(process.cwd(), ".claude", "plans");
		if (!existsSync(planDir)) return null;

		const files = readdirSync(planDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({
				name: f,
				mtime: statSync(join(planDir, f)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime);

		if (files.length === 0) return null;
		return readFileSync(join(planDir, files[0]!.name), "utf-8");
	} catch {
		return null;
	}
}
