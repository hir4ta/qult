import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PlanTask {
	name: string;
	status: "done" | "pending" | "in-progress";
}

// ### Task N: <name> [status]
const TASK_RE = /^###\s+Task\s+\d+:\s*(.+?)(?:\s*\[(done|pending|in-progress)\])?\s*$/;

// - [x] or - [ ] checkbox (Review Gates)
const CHECKBOX_RE = /^-\s+\[([ xX])\]\s*(.+)$/;

/** Parse tasks and review gates from a plan markdown string */
export function parsePlanTasks(content: string): PlanTask[] {
	const tasks: PlanTask[] = [];

	for (const line of content.split("\n")) {
		const trimmed = line.trim();

		// Match task headers: ### Task N: name [status]
		const taskMatch = trimmed.match(TASK_RE);
		if (taskMatch) {
			const name = taskMatch[1]!.trim();
			const status = (taskMatch[2] as PlanTask["status"]) ?? "pending";
			tasks.push({ name, status });
			continue;
		}

		// Match checkboxes: - [x] name or - [ ] name
		const checkMatch = trimmed.match(CHECKBOX_RE);
		if (checkMatch) {
			const checked = checkMatch[1] !== " ";
			const name = checkMatch[2]!.trim();
			tasks.push({ name, status: checked ? "done" : "pending" });
		}
	}

	return tasks;
}

/** Find and parse the latest plan file. Returns null if no plan found. */
export function getActivePlan(): { tasks: PlanTask[]; path: string } | null {
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

		const path = join(planDir, files[0]!.name);
		const content = readFileSync(path, "utf-8");
		const tasks = parsePlanTasks(content);

		if (tasks.length === 0) return null;
		return { tasks, path };
	} catch {
		return null; // fail-open
	}
}
