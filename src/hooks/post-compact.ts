import { getTopErrors } from "../state/gate-history.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan } from "../state/plan-status.ts";
import {
	isReviewRequired,
	readLastReview,
	readLastTestPass,
	readPace,
} from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";

/**
 * PostCompact: structured handoff after context compaction.
 *
 * Compaction discards earlier conversation. This hook re-injects all critical
 * state so Claude can resume effectively — the best context-reset strategy
 * available within Claude Code's hook system.
 *
 * Source: Anthropic "Harness Design for Long-Running Apps" (2026-03-24)
 *   "Context resets — clearing the context window entirely and starting a
 *    fresh agent, combined with a structured handoff that carries the
 *    previous agent's state and the next steps — addresses both these issues."
 */
export default async function postCompact(_ev: HookEvent): Promise<void> {
	const sections: string[] = [];

	// 1. Pending fixes (highest priority — blocks editing other files)
	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		const fileList = fixes
			.map((f) => `${f.file} (${f.gate}: ${f.errors[0] ?? "error"})`)
			.join("; ");
		sections.push(
			`PENDING FIXES (${fixes.length}): ${fileList}. Fix these before editing other files.`,
		);
	}

	// 2. Plan progress
	const plan = getActivePlan();
	if (plan && plan.tasks.length > 0) {
		const done = plan.tasks.filter((t) => t.status === "done");
		const inProgress = plan.tasks.filter((t) => t.status === "in-progress");
		const pending = plan.tasks.filter((t) => t.status === "pending");
		const parts: string[] = [`Plan: ${plan.path}`];
		if (done.length > 0) parts.push(`Done: ${done.map((t) => t.name).join(", ")}`);
		if (inProgress.length > 0)
			parts.push(`In progress: ${inProgress.map((t) => t.name).join(", ")}`);
		if (pending.length > 0) parts.push(`Remaining: ${pending.map((t) => t.name).join(", ")}`);
		sections.push(parts.join(". "));
	}

	// 3. Gate clearance status (test pass / review)
	const testPass = readLastTestPass();
	const review = readLastReview();
	const clearance: string[] = [];
	if (testPass) clearance.push(`tests passed (${testPass.command})`);
	else clearance.push("tests NOT passed");
	if (review) clearance.push("review completed");
	else if (isReviewRequired()) clearance.push("review NOT completed (REQUIRED)");
	else clearance.push("review not completed (optional for this change size)");
	sections.push(`Commit gates: ${clearance.join(", ")}`);

	// 4. Pace status
	const pace = readPace();
	if (pace) {
		const commitTime = new Date(pace.last_commit_at).getTime();
		if (!Number.isNaN(commitTime)) {
			const elapsed = Math.round((Date.now() - commitTime) / 60_000);
			sections.push(`Pace: ${elapsed}min since last commit, ${pace.changed_files} files changed`);
		}
	}

	// 5. Recent error trends (top 3)
	const errors = getTopErrors(3);
	if (errors.length > 0) {
		const trends = errors.map((e) => `${e.gate}: ${e.error} (×${e.count})`).join("; ");
		sections.push(`Error trends: ${trends}`);
	}

	if (sections.length > 0) {
		process.stderr.write(
			`[alfred] Post-compaction state:\n${sections.map((s) => `  ${s}`).join("\n")}\n`,
		);
	}
}
