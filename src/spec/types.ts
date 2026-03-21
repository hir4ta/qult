import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parse, stringify } from "yaml";

export type SpecFile =
	| "requirements.md"
	| "design.md"
	| "tasks.md"
	| "test-specs.md"
	| "decisions.md"
	| "research.md"
	| "session.md"
	| "bugfix.md";
export type SpecSize = "S" | "M" | "L";
export type SpecType = "feature" | "bugfix";

/** Sizes that require dashboard approval before implementation. */
export const APPROVAL_REQUIRED_SIZES: ReadonlySet<string> = new Set(["M", "L"]);
export type ReviewStatus = "pending" | "approved" | "changes_requested" | "";
export type TaskStatus = "pending" | "in-progress" | "review" | "done" | "deferred" | "cancelled";

const TASK_STATUSES = new Set<string>(["pending", "in-progress", "review", "done", "deferred", "cancelled"]);

export const VALID_TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map([
	["pending", new Set<TaskStatus>(["in-progress", "cancelled"])],
	["in-progress", new Set<TaskStatus>(["review", "deferred", "cancelled"])],
	["review", new Set<TaskStatus>(["in-progress", "done", "cancelled"])],
	["deferred", new Set<TaskStatus>(["in-progress", "cancelled"])],
]);

export function isTaskStatus(s: string): s is TaskStatus {
	return TASK_STATUSES.has(s);
}

export function transitionStatus(current: TaskStatus, next: TaskStatus): TaskStatus {
	if (current === next) throw new Error(`InvalidTransition: ${current} → ${next} (same state)`);
	const allowed = VALID_TRANSITIONS.get(current);
	if (!allowed?.has(next)) {
		throw new Error(`InvalidTransition: ${current} → ${next}`);
	}
	return next;
}

export function effectiveStatus(raw?: string): TaskStatus {
	if (!raw || raw === "active") return "in-progress";
	if (raw === "completed") return "done";
	if (isTaskStatus(raw)) return raw;
	return "in-progress";
}

export const VALID_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ActiveTask {
	slug: string;
	started_at: string;
	status?: string;
	completed_at?: string;
	review_status?: ReviewStatus;
	size?: SpecSize;
	spec_type?: SpecType;
}

export interface ActiveState {
	primary: string;
	tasks: ActiveTask[];
}

export interface Section {
	file: SpecFile;
	content: string;
	url: string;
}

export interface InitResult {
	specDir: SpecDir;
	size: SpecSize;
	specType: SpecType;
	files: SpecFile[];
}

export function parseSize(s: string): SpecSize {
	const upper = s.toUpperCase();
	if (["S", "M", "L"].includes(upper)) return upper as SpecSize;
	throw new Error(`invalid spec size "${s}" (valid: S, M, L)`);
}

export function parseSpecType(s: string): SpecType {
	const lower = s.toLowerCase();
	if (lower === "" || lower === "feature") return "feature";
	if (lower === "bugfix") return "bugfix";
	throw new Error(`invalid spec type "${s}" (valid: feature, bugfix)`);
}

export function detectSize(description: string): SpecSize {
	const n = [...description].length;
	if (n < 100) return "S";
	if (n < 300) return "M";
	return "L";
}

export function filesForSize(size: SpecSize, specType: SpecType): SpecFile[] {
	const primary: SpecFile = specType === "bugfix" ? "bugfix.md" : "requirements.md";
	switch (size) {
		case "S":
			return [primary, "design.md", "tasks.md"];
		case "M":
			return [primary, "design.md", "tasks.md", "test-specs.md"];
		case "L":
			return [primary, "design.md", "tasks.md", "test-specs.md", "research.md"];
	}
}

// Path helpers
export function rootDir(projectPath: string): string {
	return join(projectPath, ".alfred");
}
export function specsDir(projectPath: string): string {
	return join(projectPath, ".alfred", "specs");
}
export function activePath(projectPath: string): string {
	return join(projectPath, ".alfred", "specs", "_active.md");
}

export class SpecDir {
	readonly projectPath: string;
	readonly taskSlug: string;

	constructor(projectPath: string, taskSlug: string) {
		this.projectPath = projectPath;
		this.taskSlug = taskSlug;
	}

	dir(): string {
		return join(specsDir(this.projectPath), this.taskSlug);
	}
	filePath(f: SpecFile): string {
		return join(this.dir(), f);
	}
	exists(): boolean {
		try {
			return statSync(this.dir()).isDirectory();
		} catch {
			return false;
		}
	}

	readFile(f: SpecFile): string {
		return readFileSync(this.filePath(f), "utf-8");
	}

	writeFile(f: SpecFile, content: string): void {
		this.saveHistory(f);
		this.writeFileRaw(f, content);
	}

	appendFile(f: SpecFile, content: string): void {
		let existing = "";
		try {
			existing = readFileSync(this.filePath(f), "utf-8");
		} catch {
			/* file may not exist */
		}
		this.writeFile(f, existing + content);
	}

	private writeFileRaw(f: SpecFile, content: string): void {
		const path = this.filePath(f);
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	}

	private saveHistory(f: SpecFile): void {
		try {
			const path = this.filePath(f);
			if (!existsSync(path)) return;
			const histDir = join(this.dir(), ".history");
			mkdirSync(histDir, { recursive: true });
			const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
			const histPath = join(histDir, `${f}.${ts}`);
			const content = readFileSync(path, "utf-8");
			writeFileSync(histPath, content);
			// Purge old versions (keep max 20).
			const entries = readdirSync(histDir)
				.filter((e) => e.startsWith(`${f}.`))
				.sort();
			while (entries.length > 20) {
				const old = entries.shift()!;
				try {
					rmSync(join(histDir, old));
				} catch {
					/* best effort */
				}
			}
		} catch {
			/* fail-open: history save errors don't prevent writes */
		}
	}

	allSections(): Section[] {
		const projectBase = basename(this.projectPath);
		const allFiles: SpecFile[] = [
			"requirements.md",
			"design.md",
			"tasks.md",
			"test-specs.md",
			"decisions.md",
			"research.md",
			"session.md",
			"bugfix.md",
		];
		const sections: Section[] = [];
		for (const f of allFiles) {
			try {
				const content = this.readFile(f);
				const url = `spec://${projectBase}/${this.taskSlug}/${f}`;
				sections.push({ file: f, content, url });
			} catch {
				/* skip missing files */
			}
		}
		return sections;
	}
}

// _active.md management

export function readActive(projectPath: string): string {
	const state = readActiveState(projectPath);
	if (!state.primary) throw new Error("no primary task in _active.md");
	return state.primary;
}

export function readActiveState(projectPath: string): ActiveState {
	const path = activePath(projectPath);
	let data: string;
	try {
		data = readFileSync(path, "utf-8");
	} catch {
		throw new Error("read _active.md: file not found");
	}

	// Try YAML first.
	try {
		const state = parse(data) as ActiveState;
		if (state?.primary != null || state?.tasks) return state;
	} catch {
		/* fall through to legacy */
	}

	// Legacy format.
	let slug = "",
		startedAt = "";
	for (const line of data.split("\n")) {
		if (line.startsWith("task: ")) slug = line.slice(6);
		if (line.startsWith("started_at: ")) startedAt = line.slice(12);
	}
	if (!slug) throw new Error("no task field in _active.md");
	return { primary: slug, tasks: [{ slug, started_at: startedAt }] };
}

export function writeActiveState(projectPath: string, state: ActiveState): void {
	mkdirSync(specsDir(projectPath), { recursive: true });
	const data = stringify(state);
	writeFileSync(activePath(projectPath), data);
}

export function switchActive(projectPath: string, taskSlug: string): void {
	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	if (!task) throw new Error(`task "${taskSlug}" not found in _active.md`);
	const status = effectiveStatus(task.status);
	if (status === "done" || status === "cancelled") {
		throw new Error(`task "${taskSlug}" is ${status}`);
	}
	state.primary = taskSlug;
	writeActiveState(projectPath, state);
}

export function completeTask(projectPath: string, taskSlug: string): string {
	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	if (!task) throw new Error(`task "${taskSlug}" not found in _active.md`);
	const current = effectiveStatus(task.status);
	if (current === "done") throw new Error(`task "${taskSlug}" is already done`);
	if (current === "cancelled") throw new Error(`task "${taskSlug}" is cancelled`);
	// Allow completion from review (normal flow) or in-progress (forced complete)
	task.status = "done";
	task.completed_at = new Date().toISOString();

	if (state.primary === taskSlug) {
		state.primary =
			state.tasks.find((t) => {
				const s = effectiveStatus(t.status);
				return s !== "done" && s !== "cancelled" && t.slug !== taskSlug;
			})?.slug ?? "";
	}

	// Issue #22: Remove completed entry from _active.md to prevent accumulation.
	state.tasks = state.tasks.filter((t) => t.slug !== taskSlug);
	if (state.tasks.length === 0) {
		try {
			rmSync(activePath(projectPath));
		} catch {
			/* ignore */
		}
		return state.primary;
	}
	writeActiveState(projectPath, state);
	return state.primary;
}

export function setReviewStatus(projectPath: string, taskSlug: string, status: ReviewStatus): void {
	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	if (!task) throw new Error(`task "${taskSlug}" not found in _active.md`);
	task.review_status = status;
	writeActiveState(projectPath, state);
}

export function reviewStatusFor(projectPath: string, taskSlug: string): ReviewStatus {
	try {
		const state = readActiveState(projectPath);
		return state.tasks.find((t) => t.slug === taskSlug)?.review_status ?? "";
	} catch {
		return "";
	}
}

export interface ReviewVerification {
	valid: boolean;
	reason: string;
}

/**
 * Verify that a valid review JSON file exists with status=approved and zero unresolved comments.
 * Does NOT read _active.md (no overlap with reviewStatusFor).
 *
 * Legacy mode: if reviews/ directory is absent → valid (backward compat).
 * If reviews/ exists but is empty → invalid.
 */
export function verifyReviewFile(projectPath: string, taskSlug: string): ReviewVerification {
	const reviewsDir = join(specsDir(projectPath), taskSlug, "reviews");

	// Legacy mode: no reviews/ directory = pre-enforcement era.
	if (!existsSync(reviewsDir)) {
		return { valid: true, reason: "legacy: no reviews/ directory" };
	}

	let files: string[];
	try {
		files = readdirSync(reviewsDir)
			.filter((f) => f.startsWith("review-") && f.endsWith(".json"))
			.sort()
			.reverse();
	} catch {
		return { valid: false, reason: "failed to read reviews/ directory" };
	}

	if (files.length === 0) {
		return { valid: false, reason: "no review JSON files found in reviews/" };
	}

	// Parse the latest review file.
	const latestFile = files[0]!;
	let reviewData: { status?: string; comments?: Array<{ resolved?: boolean }> };
	try {
		reviewData = JSON.parse(readFileSync(join(reviewsDir, latestFile), "utf-8"));
	} catch {
		return { valid: false, reason: `failed to parse ${latestFile}` };
	}

	if (reviewData.status !== "approved") {
		return {
			valid: false,
			reason: `latest review status is "${reviewData.status ?? "unknown"}", not "approved"`,
		};
	}

	// Check for unresolved comments (missing resolved field → treated as unresolved).
	if (Array.isArray(reviewData.comments)) {
		const unresolved = reviewData.comments.filter((c) => !c.resolved).length;
		if (unresolved > 0) {
			return { valid: false, reason: `${unresolved} unresolved review comment(s) remain` };
		}
	}

	return { valid: true, reason: `verified via ${latestFile}` };
}

export function removeTask(projectPath: string, taskSlug: string): boolean {
	const state = readActiveState(projectPath);
	const filtered = state.tasks.filter((t) => t.slug !== taskSlug);
	if (filtered.length === state.tasks.length) {
		throw new Error(`task "${taskSlug}" not found in _active.md`);
	}

	const sd = new SpecDir(projectPath, taskSlug);
	if (sd.exists()) {
		rmSync(sd.dir(), { recursive: true, force: true });
	}

	if (filtered.length === 0) {
		try {
			rmSync(activePath(projectPath));
		} catch {
			/* ignore */
		}
		return true;
	}

	state.tasks = filtered;
	if (state.primary === taskSlug) {
		state.primary = filtered[0]!.slug;
	}
	writeActiveState(projectPath, state);
	return false;
}
