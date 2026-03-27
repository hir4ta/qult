import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PlanTask {
	name: string;
	status: "done" | "pending" | "in-progress";
}

// ### Task N: <name> [status]
export const TASK_RE = /^###\s+Task\s+\d+:\s*(.+?)(?:\s*\[(done|pending|in-progress)\])?\s*$/;

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

export interface VerifyField {
	taskName: string;
	testFile: string;
	testFunction: string | null;
}

// - **Verify**: test-file:function or - **Verify**: test-file
const VERIFY_RE = /^\s*-\s+\*{0,2}Verify\*{0,2}:\s*(\S+?)(?::(\S+))?\s*$/;

/** Parse Verify fields from plan content, associating each with its task */
export function parseVerifyFields(content: string): VerifyField[] {
	const verifies: VerifyField[] = [];
	let currentTask: string | null = null;

	for (const line of content.split("\n")) {
		const taskMatch = line.trim().match(TASK_RE);
		if (taskMatch) {
			currentTask = taskMatch[1]!.trim();
			continue;
		}

		if (currentTask) {
			const verifyMatch = line.match(VERIFY_RE);
			if (verifyMatch) {
				verifies.push({
					taskName: currentTask,
					testFile: verifyMatch[1]!,
					testFunction: verifyMatch[2] ?? null,
				});
			}
		}
	}

	return verifies;
}

export interface FileField {
	taskName: string;
	filePath: string;
}

// - **File**: path/to/file.ts  or  - File: path/to/file.ts
const FILE_RE = /^\s*-\s+\*{0,2}File\*{0,2}:\s*(\S+)\s*$/;

/** Parse File fields from plan content, associating each with its task */
export function parseFileFields(content: string): FileField[] {
	const files: FileField[] = [];
	let currentTask: string | null = null;

	for (const line of content.split("\n")) {
		const taskMatch = line.trim().match(TASK_RE);
		if (taskMatch) {
			currentTask = taskMatch[1]!.trim();
			continue;
		}

		if (currentTask) {
			const fileMatch = line.match(FILE_RE);
			if (fileMatch) {
				files.push({ taskName: currentTask, filePath: fileMatch[1]! });
			}
		}
	}

	return files;
}

/** Extract backtick-quoted commands from Success Criteria section */
export function parseCriteriaCommands(content: string): string[] {
	const commands: string[] = [];
	const criteriaMatch = /^##\s+success\s*criteria/im.exec(content);
	if (!criteriaMatch) return commands;

	const section = content.slice(criteriaMatch.index);
	const sectionEnd = section.search(/\n##\s/);
	const criteriaBlock = sectionEnd >= 0 ? section.slice(0, sectionEnd) : section;

	for (const line of criteriaBlock.split("\n")) {
		if (!/^\s*-\s+\[/.test(line)) continue;
		for (const m of line.matchAll(/`([^`]+)`/g)) {
			commands.push(m[1]!);
		}
	}

	return commands;
}

/** Get the path of the latest plan file (by mtime). Returns null if none found. */
function getLatestPlanPath(): string | null {
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
		return join(planDir, files[0]!.name);
	} catch {
		return null;
	}
}

/** Find and parse the latest plan file. Returns null if no plan found or no tasks. */
export function getActivePlan(): { tasks: PlanTask[]; path: string } | null {
	const path = getLatestPlanPath();
	if (!path) return null;

	try {
		const content = readFileSync(path, "utf-8");
		const tasks = parsePlanTasks(content);
		if (tasks.length === 0) return null;
		return { tasks, path };
	} catch {
		return null; // fail-open
	}
}

/** Get the content of the latest plan file. Returns null if no plan found. */
export function getLatestPlanContent(): string | null {
	const path = getLatestPlanPath();
	if (!path) return null;

	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}
