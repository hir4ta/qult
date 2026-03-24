import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYAML } from "yaml";

export type SpecFile =
	| "requirements.md"
	| "design.md"
	| "research.md"
	| "tasks.json"
	| "test-specs.json"
	| "bugfix.json"
	// Legacy markdown (read-only, for backward compatibility)
	| "tasks.md"
	| "test-specs.md"
	| "bugfix.md"
	| "decisions.md"
	| "research.md"
	| "session.md";

// --- JSON spec schemas ---

export interface SpecTask {
	id: string;
	title: string;
	size?: "S" | "M" | "L";
	checked: boolean;
	requirements?: string[];
	depends?: string[];
	files?: string[];
	verify?: string;
	subtasks?: string[];
}

export interface SpecWave {
	key: number | "closing";
	title: string;
	tasks: SpecTask[];
}

export interface TasksFile {
	slug: string;
	waves: SpecWave[];
	closing: SpecWave;
	dependency_graph?: Record<string, string[]>;
}

export interface TestScenario {
	name: string;
	steps: string[];
}

export interface TestSpec {
	id: string;
	title: string;
	source?: string;
	scenarios: TestScenario[];
}

export interface TestSpecsFile {
	specs: TestSpec[];
}

export interface BugfixFile {
	summary: string;
	severity: "P0" | "P1" | "P2" | "P3";
	impact?: string;
	reproduction_steps: string[];
	root_cause: string;
	five_whys?: string[];
	fix_strategy: string;
	regression_prevention?: string;
	confidence?: number;
}

export type SpecSize = "S" | "M" | "L";
export type SpecType = "feature" | "bugfix";

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
	size?: SpecSize;
	spec_type?: SpecType;
	owner?: string;
}

export interface ActiveState {
	primary: string;
	tasks: ActiveTask[];
}

export interface TerminalState {
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
	const primary: SpecFile = specType === "bugfix" ? "bugfix.json" : "requirements.md";
	switch (size) {
		case "S":
			return [primary, "design.md", "tasks.json"];
		case "M":
			return [primary, "design.md", "tasks.json", "test-specs.json"];
		case "L":
			return [primary, "design.md", "tasks.json", "test-specs.json", "research.md"];
	}
}

export function alfredDir(projectPath: string): string {
	return join(projectPath, ".alfred");
}
export function specsDir(projectPath: string): string {
	return join(projectPath, ".alfred", "specs");
}
export function activePath(projectPath: string): string {
	return join(projectPath, ".alfred", "specs", "_active.json");
}
export function completePath(projectPath: string): string {
	return join(projectPath, ".alfred", "specs", "_complete.json");
}
export function cancelPath(projectPath: string): string {
	return join(projectPath, ".alfred", "specs", "_cancel.json");
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

// --- JSON state file helpers ---

function readJsonState<T>(path: string, fallback: T): T {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw err;
	}
	return JSON.parse(raw);
}

function writeJsonState(filePath: string, data: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
	renameSync(tmp, filePath);
}

function appendToTerminalState(filePath: string, task: ActiveTask): void {
	const state = readJsonState<TerminalState>(filePath, { tasks: [] });
	state.tasks.push(task);
	writeJsonState(filePath, state);
}

// --- Migration from _active.md ---

function legacyActivePath(projectPath: string): string {
	return join(projectPath, ".alfred", "specs", "_active.md");
}

function migrateFromMarkdown(projectPath: string): ActiveState | null {
	const mdPath = legacyActivePath(projectPath);
	if (!existsSync(mdPath)) return null;

	const data = readFileSync(mdPath, "utf-8");
	let state: ActiveState | null = null;

	// Try YAML-like format (primary + tasks array)
	try {
		const parsed = parseYAML(data) as ActiveState;
		if (parsed?.primary != null || parsed?.tasks) {
			state = parsed;
		}
	} catch {
		/* fall through to legacy */
	}

	// Legacy format (task: slug / started_at: ...)
	if (!state) {
		let slug = "";
		let startedAt = "";
		for (const line of data.split("\n")) {
			if (line.startsWith("task: ")) slug = line.slice(6);
			if (line.startsWith("started_at: ")) startedAt = line.slice(12);
		}
		if (slug) {
			state = { primary: slug, tasks: [{ slug, started_at: startedAt }] };
		}
	}

	if (state) {
		// Write JSON and remove legacy file
		writeJsonState(activePath(projectPath), state);
		rmSync(mdPath, { force: true });
		return state;
	}

	return null;
}

// --- State management ---

export function readActive(projectPath: string): string {
	const state = readActiveState(projectPath);
	if (!state.primary) throw new Error("no primary task in _active.json");
	return state.primary;
}

export function readActiveState(projectPath: string): ActiveState {
	const jsonPath = activePath(projectPath);

	// Try JSON first
	if (existsSync(jsonPath)) {
		return readJsonState<ActiveState>(jsonPath, { primary: "", tasks: [] });
	}

	// Try migration from _active.md
	const migrated = migrateFromMarkdown(projectPath);
	if (migrated) return migrated;

	return { primary: "", tasks: [] };
}

export function readCompleteState(projectPath: string): TerminalState {
	return readJsonState<TerminalState>(completePath(projectPath), { tasks: [] });
}

export function readCancelState(projectPath: string): TerminalState {
	return readJsonState<TerminalState>(cancelPath(projectPath), { tasks: [] });
}

export function writeActiveState(projectPath: string, state: ActiveState): void {
	writeJsonState(activePath(projectPath), state);
}

export function switchActive(projectPath: string, taskSlug: string): void {
	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	if (!task) throw new Error(`task "${taskSlug}" not found in _active.json`);
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
	if (!task) throw new Error(`task "${taskSlug}" not found in _active.json`);
	const current = effectiveStatus(task.status);
	if (current === "done") throw new Error(`task "${taskSlug}" is already done`);
	if (current === "cancelled") throw new Error(`task "${taskSlug}" is cancelled`);
	if (state.primary === taskSlug) {
		state.primary =
			state.tasks.find((t) => {
				const s = effectiveStatus(t.status);
				return s !== "done" && s !== "cancelled" && t.slug !== taskSlug;
			})?.slug ?? "";
	}

	// Move to _complete.json with completed_at timestamp
	task.status = "completed";
	task.completed_at = new Date().toISOString();
	appendToTerminalState(completePath(projectPath), task);

	// Remove from _active.json
	state.tasks = state.tasks.filter((t) => t.slug !== taskSlug);
	writeActiveState(projectPath, state);
	return state.primary;
}

export function cancelTask(projectPath: string, taskSlug: string): string {
	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	if (!task) throw new Error(`task "${taskSlug}" not found in _active.json`);

	// Move to _cancel.json
	task.status = "cancelled";
	appendToTerminalState(cancelPath(projectPath), task);

	// Remove from _active.json
	state.tasks = state.tasks.filter((t) => t.slug !== taskSlug);
	if (state.primary === taskSlug) {
		state.primary = state.tasks[0]?.slug ?? "";
	}
	writeActiveState(projectPath, state);
	return state.primary;
}

export function removeTask(projectPath: string, taskSlug: string): boolean {
	const state = readActiveState(projectPath);
	const filtered = state.tasks.filter((t) => t.slug !== taskSlug);
	if (filtered.length === state.tasks.length) {
		throw new Error(`task "${taskSlug}" not found in _active.json`);
	}

	const sd = new SpecDir(projectPath, taskSlug);
	if (sd.exists()) {
		rmSync(sd.dir(), { recursive: true, force: true });
	}

	state.tasks = filtered;
	if (state.primary === taskSlug) {
		state.primary = filtered[0]?.slug ?? "";
	}
	writeActiveState(projectPath, state);
	return filtered.length === 0;
}
