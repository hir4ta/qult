import { defineCommand } from "citty";
import { loadGates } from "./gates/load.ts";
import { readPendingFixes } from "./state/pending-fixes.ts";
import { getActivePlan } from "./state/plan-status.ts";
import { isReviewRequired, readLastReview, readLastTestPass } from "./state/session-state.ts";

/** Display current qult state and blockers */
export function runStatus(): void {
	const lines: string[] = ["[qult status]"];

	// Pending fixes
	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		lines.push(`  Pending fixes: ${fixes.length}`);
		for (const f of fixes) {
			lines.push(`    ${f.file} (${f.gate}: ${f.errors[0]?.slice(0, 80) ?? "error"})`);
		}
	} else {
		lines.push("  Pending fixes: 0");
	}

	// Test gate
	const testPass = readLastTestPass();
	lines.push(testPass ? `  Test gate: passed (${testPass.command})` : "  Test gate: NOT passed");

	// Review
	const review = readLastReview();
	if (review) {
		lines.push("  Review: completed");
	} else if (isReviewRequired()) {
		lines.push("  Review: NOT completed (required)");
	} else {
		lines.push("  Review: not completed (optional)");
	}

	// Plan
	const plan = getActivePlan();
	if (plan && plan.tasks.length > 0) {
		const done = plan.tasks.filter((t) => t.status === "done").length;
		const inProgress = plan.tasks.filter((t) => t.status === "in-progress").length;
		const parts = [`${done}/${plan.tasks.length} done`];
		if (inProgress > 0) parts.push(`${inProgress} in-progress`);
		lines.push(`  Plan: ${parts.join(", ")}`);
	}

	// Gates
	const gates = loadGates();
	if (gates) {
		const gateNames: string[] = [];
		if (gates.on_write) gateNames.push(...Object.keys(gates.on_write));
		if (gates.on_commit) gateNames.push(...Object.keys(gates.on_commit));
		if (gates.on_review) gateNames.push(...Object.keys(gates.on_review));
		if (gateNames.length > 0) {
			lines.push(`  Gates: ${gateNames.join(", ")}`);
		}
	}

	process.stdout.write(`${lines.join("\n")}\n`);
}

export const statusCommand = defineCommand({
	meta: { description: "Show current qult state and blockers" },
	async run() {
		runStatus();
	},
});
