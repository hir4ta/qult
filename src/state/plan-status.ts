import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
					file = fileMatch[1]!.trim().replace(/[`"']/g, "");
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
 *  Format: "src/__tests__/foo.test.ts:testFoo" → { file, testName }
 *  Strips backticks and quotes that markdown formatting may introduce. */
export function parseVerifyField(verify: string): { file: string; testName: string } | null {
	// Strip backticks and quotes from markdown formatting
	const cleaned = verify.replace(/[`"']/g, "");
	const colonIdx = cleaned.lastIndexOf(":");
	if (colonIdx <= 0) return null;
	const file = cleaned.slice(0, colonIdx).trim();
	const testName = cleaned.slice(colonIdx + 1).trim();
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
 *  Collects candidates from all sources, then returns the most recently modified.
 *  Sources: .claude/plans/ (project) → CLAUDE_PLANS_DIR env → ~/.claude/plans/ (user home, <24h) */
function getLatestPlanPath(): string | null {
	try {
		const candidates: { path: string; mtime: number }[] = [];

		// 1. Project-local plans (highest priority)
		const projectDir = join(process.cwd(), ".claude", "plans");
		const projectPlans = scanPlanDir(projectDir);
		candidates.push(...projectPlans);

		// 2. CLAUDE_PLANS_DIR env var (explicit override)
		const envDir = process.env.CLAUDE_PLANS_DIR;
		if (envDir) {
			candidates.push(...scanPlanDir(envDir));
		}

		// 3. User home ~/.claude/plans/ (Claude Code stores plans here in some modes)
		// Only use as fallback when NO project-local or env plans exist.
		// This prevents cross-project plan contamination (e.g. project B's plan
		// blocking commits in project A because it was most recently modified).
		if (!_disableHomeFallback && projectPlans.length === 0 && candidates.length === 0) {
			try {
				const homeDir = join(homedir(), ".claude", "plans");
				const homeFiles = scanPlanDir(homeDir);
				const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
				candidates.push(...homeFiles.filter((f) => f.mtime > recentCutoff));
			} catch {
				/* fail-open: homedir() may fail in sandboxed environments */
			}
		}

		if (candidates.length === 0) return null;

		// Return the most recently modified file across all sources
		candidates.sort((a, b) => b.mtime - a.mtime);
		return candidates[0]!.path;
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
		// Check project-local plans
		const projectPlanDir = join(process.cwd(), ".claude", "plans");
		if (existsSync(projectPlanDir) && readdirSync(projectPlanDir).some((f) => f.endsWith(".md"))) {
			return true;
		}
		// Check user home plans (same as getLatestPlanPath fallback)
		if (!_disableHomeFallback) {
			const homePlanDir = join(homedir(), ".claude", "plans");
			if (existsSync(homePlanDir) && readdirSync(homePlanDir).some((f) => f.endsWith(".md"))) {
				return true;
			}
		}
		return false;
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

/** Parse Success Criteria bullet points from a plan markdown string.
 *  Extracts items under the `## Success Criteria` section header. */
export function parseSuccessCriteria(content: string): string[] {
	const lines = content.split("\n");
	const criteria: string[] = [];
	let inSection = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^##\s+Success\s+Criteria/i.test(trimmed)) {
			inSection = true;
			continue;
		}
		// Stop at next heading
		if (inSection && /^##\s/.test(trimmed)) break;
		if (!inSection) continue;

		// Match bullet points: - item or * item
		const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
		if (bulletMatch) {
			criteria.push(bulletMatch[1]!.trim());
		}
	}
	return criteria;
}

/** Archive a plan file by moving it to an archive/ subdirectory.
 *  Fail-open: does not throw on any error. */
export function archivePlanFile(planPath: string): void {
	try {
		if (!existsSync(planPath)) return;
		const dir = dirname(planPath);
		const archiveDir = join(dir, "archive");
		mkdirSync(archiveDir, { recursive: true });
		renameSync(planPath, join(archiveDir, basename(planPath)));
		// Invalidate plan cache
		_planCache = null;
		_planCachePath = null;
		_planCacheMtime = null;
	} catch {
		/* fail-open */
	}
}
