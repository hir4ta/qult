import { readFileSync, writeFileSync } from "node:fs";
import { getActivePlan } from "../state/plan-status.ts";
import type { HookEvent } from "../types.ts";

// Match: ### Task N: <name> [status]
const TASK_LINE_RE = /^(###\s+Task\s+\d+:\s*)(.+?)(\s*\[)(pending|in-progress|done)(\]\s*)$/;

/** TaskCompleted: sync Claude's task completion with Plan file status */
export default async function taskCompleted(ev: HookEvent): Promise<void> {
	const subject = typeof ev.task_subject === "string" ? ev.task_subject : null;
	if (!subject) return;

	const plan = getActivePlan();
	if (!plan) return; // fail-open: no plan → allow

	// Find matching task in plan and update status to [done]
	const updated = updatePlanTaskStatus(plan.path, subject);
	if (updated) {
		// TaskCompleted does not support hookSpecificOutput.additionalContext
		process.stderr.write(`[alfred] Plan updated: "${subject}" marked as [done]\n`);
	}
}

/** Update a task's status in the plan file. Returns true if a match was found and updated. */
function updatePlanTaskStatus(planPath: string, taskSubject: string): boolean {
	try {
		const content = readFileSync(planPath, "utf-8");
		const normalizedSubject = taskSubject.toLowerCase().trim();
		let found = false;

		const updatedLines = content.split("\n").map((line) => {
			if (found) return line; // only update first match

			const match = line.match(TASK_LINE_RE);
			if (!match) return line;

			const taskName = match[2]!.trim().toLowerCase();

			// Fuzzy match: plan task name contains subject or vice versa
			if (taskName.includes(normalizedSubject) || normalizedSubject.includes(taskName)) {
				found = true;
				return `${match[1]}${match[2]}${match[3]}done${match[5]}`;
			}

			return line;
		});

		if (found) {
			writeFileSync(planPath, updatedLines.join("\n"));
		}
		return found;
	} catch {
		return false; // fail-open
	}
}
