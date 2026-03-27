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
		let bestMatchIdx = -1;
		let bestScore = 0;

		const lines = content.split("\n");

		// First pass: find best matching task
		for (let i = 0; i < lines.length; i++) {
			const match = lines[i]!.match(TASK_LINE_RE);
			if (!match || match[4] === "done") continue;

			const taskName = match[2]!.trim().toLowerCase();
			const score = matchScore(taskName, normalizedSubject);
			if (score > bestScore) {
				bestScore = score;
				bestMatchIdx = i;
			}
		}

		// Require minimum 50% word overlap to avoid false positives
		if (bestMatchIdx >= 0 && bestScore >= 0.5) {
			const match = lines[bestMatchIdx]!.match(TASK_LINE_RE)!;
			lines[bestMatchIdx] = `${match[1]}${match[2]}${match[3]}done${match[5]}`;
			found = true;
		}

		if (found) {
			writeFileSync(planPath, lines.join("\n"));
		}
		return found;
	} catch {
		return false; // fail-open
	}
}

/** Score how well two task names match (0-1). Uses word overlap ratio. */
function matchScore(a: string, b: string): number {
	// Exact match
	if (a === b) return 1;

	// Substring match (one contains the other)
	if (a.includes(b) || b.includes(a)) {
		const shorter = Math.min(a.length, b.length);
		const longer = Math.max(a.length, b.length);
		return shorter / longer;
	}

	// Word overlap
	const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 1));
	const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 1));
	if (wordsA.size === 0 || wordsB.size === 0) return 0;

	let overlap = 0;
	for (const w of wordsA) {
		if (wordsB.has(w)) overlap++;
	}
	return overlap / Math.max(wordsA.size, wordsB.size);
}
