import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PlanTask {
	name: string;
	status: "done" | "pending" | "in-progress";
	taskNumber?: number;
	file?: string;
	verify?: string;
}

// ### Task N: <name> [status]  or  ### Task N - <name> [status]
export const TASK_RE = /^###\s+Task\s+(\d+)[\s:-]+(.+?)(?:\s*\[(done|pending|in-progress)\])?\s*$/i;

// - [x] or - [ ] checkbox (Review Gates)
const CHECKBOX_RE = /^-\s+\[([ xX])\]\s*(.+)$/;
const FILE_LINE_RE = /^\s*-\s*\*\*File\*\*:\s*(.+)$/;
const VERIFY_LINE_RE = /^\s*-\s*\*\*Verify\*\*:\s*(.+)$/;

/** Parse tasks and review gates from a plan markdown string */
export function parsePlanTasks(content: string): PlanTask[] {
	const tasks: PlanTask[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();

		// Match task headers: ### Task N: name [status]
		const taskMatch = trimmed.match(TASK_RE);
		if (taskMatch) {
			const taskNumber = Number(taskMatch[1]);
			const name = taskMatch[2]!.trim();
			const status = (taskMatch[3]?.toLowerCase() as PlanTask["status"]) ?? "pending";
			// Look ahead for **File** and **Verify** fields in the task block
			let file: string | undefined;
			let verify: string | undefined;
			for (let j = i + 1; j < lines.length; j++) {
				const nextTrimmed = lines[j]!.trim();
				// Stop at next task header or section header
				if (/^###?\s/.test(nextTrimmed)) break;
				const fileMatch = nextTrimmed.match(FILE_LINE_RE);
				if (fileMatch) {
					file = fileMatch[1]!.trim();
					continue;
				}
				const verifyMatch = nextTrimmed.match(VERIFY_LINE_RE);
				if (verifyMatch) {
					verify = verifyMatch[1]!.trim();
				}
			}
			tasks.push({ name, status, taskNumber, file, verify });
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

/** Parse a Verify field value into file and test name.
 *  Format: "src/__tests__/foo.test.ts:testFoo" → { file, testName } */
export function parseVerifyField(verify: string): { file: string; testName: string } | null {
	const colonIdx = verify.lastIndexOf(":");
	if (colonIdx <= 0) return null;
	const file = verify.slice(0, colonIdx).trim();
	const testName = verify.slice(colonIdx + 1).trim();
	if (!file || !testName) return null;
	return { file, testName };
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

// Process-scoped cache for active plan
let _planCache: { tasks: PlanTask[]; path: string } | null = null;
let _planCachePath: string | null = null;
let _planCacheMtime: number | null = null;

/** Find and parse the latest plan file. Returns null if no plan found or no tasks. */
export function getActivePlan(): { tasks: PlanTask[]; path: string } | null {
	const path = getLatestPlanPath();
	if (!path) return null;

	// Return cache if same path and mtime (plan file hasn't changed)
	let mtime: number | null = null;
	try {
		mtime = statSync(path).mtimeMs;
		if (_planCache && _planCachePath === path && _planCacheMtime === mtime) return _planCache;
	} catch {
		// fall through to re-read
	}

	try {
		const content = readFileSync(path, "utf-8");
		const tasks = parsePlanTasks(content);
		if (tasks.length === 0) return null;
		_planCache = { tasks, path };
		_planCachePath = path;
		_planCacheMtime = mtime;
		return _planCache;
	} catch {
		return null; // fail-open
	}
}

/** Reset plan cache (for tests). */
export function resetPlanCache(): void {
	_planCache = null;
	_planCachePath = null;
	_planCacheMtime = null;
}
