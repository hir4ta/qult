import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PlanTask {
	name: string;
	status: "done" | "pending" | "in-progress";
	taskNumber?: number;
	file?: string;
	verify?: string;
}

// ### Task N: <name> [status]  or  ### Task N - <name> [status]  or  ### Task N — <name> [status]
export const TASK_RE = /^###\s+Task\s+(\d+)[\s:\-\u2013\u2014]+(.+?)(?:\s*\[([^\]]+)\])?\s*$/i;

/** Normalize free-form status strings to PlanTask status values (fail-open: unknown → "pending"). */
export function normalizeStatus(raw: string | undefined): PlanTask["status"] {
	if (!raw) return "pending";
	const s = raw.toLowerCase().trim();
	if (s === "done" || s === "complete" || s === "completed" || s === "finished") return "done";
	if (s === "in-progress" || s === "wip" || s === "started" || s === "working")
		return "in-progress";
	return "pending";
}

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
			const status = normalizeStatus(taskMatch[3]);
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

/** Scan a directory for .md plan files, return sorted by mtime (newest first). */
function scanPlanDir(dir: string): { path: string; mtime: number }[] {
	try {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({
				path: join(dir, f),
				mtime: statSync(join(dir, f)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime);
	} catch {
		return [];
	}
}

/** Get the path of the latest plan file (by mtime). Returns null if none found.
 *  Search order: .claude/plans/ (project) → CLAUDE_PLANS_DIR env → ~/.claude/plans/ (user home) */
function getLatestPlanPath(): string | null {
	try {
		// 1. Project-local plans (primary)
		const projectDir = join(process.cwd(), ".claude", "plans");
		const projectFiles = scanPlanDir(projectDir);
		if (projectFiles.length > 0) return projectFiles[0]!.path;

		// 2. CLAUDE_PLANS_DIR env var (explicit override)
		const envDir = process.env.CLAUDE_PLANS_DIR;
		if (envDir) {
			const envFiles = scanPlanDir(envDir);
			if (envFiles.length > 0) return envFiles[0]!.path;
		}

		// 3. User home ~/.claude/plans/ (Claude Code stores plans here in some modes)
		// Only consider files modified within the last 24 hours to avoid stale cross-project plans
		if (!_disableHomeFallback) {
			try {
				const homeDir = join(homedir(), ".claude", "plans");
				const homeFiles = scanPlanDir(homeDir);
				const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
				const recentHome = homeFiles.filter((f) => f.mtime > recentCutoff);
				if (recentHome.length > 0) return recentHome[0]!.path;
			} catch {
				/* fail-open: homedir() may fail in sandboxed environments */
			}
		}

		return null;
	} catch {
		return null;
	}
}

// Process-scoped cache for active plan
let _planCache: { tasks: PlanTask[]; path: string } | null = null;
let _planCachePath: string | null = null;
let _planCacheMtime: number | null = null;

/** Disable home directory fallback (for tests). */
let _disableHomeFallback = false;
export function setDisableHomeFallback(disable: boolean): void {
	_disableHomeFallback = disable;
}

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

/** Check whether a plan file exists in the project directory (any .md file counts).
 *  Only checks project-local .claude/plans/ — NOT user home.
 *  This is used for plan-required enforcement which should only apply to project-level plans. */
export function hasPlanFile(): boolean {
	try {
		const planDir = join(process.cwd(), ".claude", "plans");
		if (!existsSync(planDir)) return false;
		return readdirSync(planDir).some((f) => f.endsWith(".md"));
	} catch {
		return false;
	}
}

/** Reset plan cache (for tests). */
export function resetPlanCache(): void {
	_planCache = null;
	_planCachePath = null;
	_planCacheMtime = null;
}
