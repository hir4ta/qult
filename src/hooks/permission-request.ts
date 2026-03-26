import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent, HookResponse } from "../types.ts";

const REVIEW_GATE_PATTERN = /review/i;

/** PermissionRequest: Validate plan structure on ExitPlanMode */
export default async function permissionRequest(ev: HookEvent): Promise<void> {
	if (ev.tool?.name !== "ExitPlanMode") return;

	const planContent = findLatestPlan();
	if (!planContent) return; // fail-open: no plan found → allow

	if (!REVIEW_GATE_PATTERN.test(planContent)) {
		deny(
			"Plan is missing Review Gates. Add a '## Review Gates' section with Design Review, Phase Review, and Final Review checkboxes.",
		);
	}
}

/** Find the most recently modified plan file */
function findLatestPlan(): string | null {
	try {
		const planDir = join(process.cwd(), ".claude", "plans");
		if (!existsSync(planDir)) return null;

		const files = readdirSync(planDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({
				name: f,
				mtime: Bun.file(join(planDir, f)).lastModified,
			}))
			.sort((a, b) => b.mtime - a.mtime);

		if (files.length === 0) return null;
		return readFileSync(join(planDir, files[0]!.name), "utf-8");
	} catch {
		return null; // fail-open
	}
}

function deny(reason: string): void {
	const response: HookResponse = {
		hookSpecificOutput: {
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
	process.stdout.write(JSON.stringify(response));
	process.exit(2);
}
