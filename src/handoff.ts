import type { PlanTask } from "./state/plan-status.ts";
import type { PendingFix } from "./types.ts";

export interface HandoffInput {
	changedFiles: string[];
	pendingFixes: PendingFix[];
	planTasks: PlanTask[] | null;
	testPassed: boolean;
	reviewDone: boolean;
	disabledGates: string[];
}

/**
 * Generate a structured handoff document for starting a fresh session.
 * Pure function — takes session data as input, returns markdown string.
 */
export function generateHandoffDocument(input: HandoffInput): string {
	const { changedFiles, pendingFixes, planTasks, testPassed, reviewDone, disabledGates } = input;

	// No active session
	if (changedFiles.length === 0 && !planTasks && pendingFixes.length === 0) {
		return "No active session data to hand off.";
	}

	const sections: string[] = [];
	sections.push("## Session Handoff\n");

	// Gate status
	const gateLines: string[] = [];
	gateLines.push(`- Tests: ${testPassed ? "PASSED" : "NOT PASSED"}`);
	gateLines.push(`- Review: ${reviewDone ? "DONE" : "NOT DONE"}`);
	if (disabledGates.length > 0) {
		gateLines.push(`- Disabled gates: ${disabledGates.join(", ")}`);
	}
	sections.push(`## Gate Status\n${gateLines.join("\n")}\n`);

	// Files changed
	if (changedFiles.length > 0) {
		const fileList = changedFiles.map((f) => `- ${f}`).join("\n");
		sections.push(`## Files Changed (${changedFiles.length})\n${fileList}\n`);
	}

	// Pending fixes
	if (pendingFixes.length > 0) {
		const fixLines = pendingFixes
			.map((f) => `- [${f.gate}] ${f.file}: ${f.errors[0]?.slice(0, 150) ?? "error"}`)
			.join("\n");
		sections.push(`## Pending Fixes\n${fixLines}\n`);
	}

	// Plan progress
	if (planTasks && planTasks.length > 0) {
		const done = planTasks.filter((t) => t.status === "done").length;
		const taskLines = planTasks
			.map((t) => `- [${t.status}] ${t.taskNumber ? `Task ${t.taskNumber}: ` : ""}${t.name}`)
			.join("\n");
		sections.push(`## Plan Progress (${done}/${planTasks.length} done)\n${taskLines}\n`);
	}

	return sections.join("\n");
}
