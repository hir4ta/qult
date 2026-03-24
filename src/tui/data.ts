/**
 * Data layer for TUI — reads directly from filesystem.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../store/index.js";

export interface TaskItem {
	id: string;
	label: string;
	checked: boolean;
}

export interface WaveInfo {
	key: string;
	title: string;
	total: number;
	checked: number;
	isCurrent: boolean;
	tasks: TaskItem[];
}

export interface TaskInfo {
	slug: string;
	status: string;
	size: string;
	specType: string;
	startedAt: string;
	focus: string;
	completed: number;
	total: number;
	waves: WaveInfo[];
	projectName: string;
}

// --- State file readers ---

type TaskEntry = { slug: string; status?: string; started_at?: string; size?: string; spec_type?: string };
type StateFile = { primary?: string; tasks: TaskEntry[] };

function readJsonState(path: string): StateFile {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return { tasks: [] };
	}
}

function readActiveState(projPath: string): StateFile & { primary: string } {
	const p = join(projPath, ".alfred", "specs", "_active.json");
	const state = readJsonState(p);
	return { primary: state.primary ?? "", tasks: state.tasks };
}

function readCompleteState(projPath: string): StateFile {
	return readJsonState(join(projPath, ".alfred", "specs", "_complete.json"));
}

function readCancelState(projPath: string): StateFile {
	return readJsonState(join(projPath, ".alfred", "specs", "_cancel.json"));
}

// --- Wave + task parser ---

// --- JSON → WaveInfo conversion ---

interface TasksJson {
	slug: string;
	waves: Array<{ key: number | string; title: string; tasks: Array<{ id: string; title: string; checked: boolean }> }>;
	closing: { key: number | string; title: string; tasks: Array<{ id: string; title: string; checked: boolean }> };
}

function jsonToWaves(data: TasksJson): WaveInfo[] {
	const allWaves = [...data.waves, data.closing];
	const result: WaveInfo[] = allWaves.map(w => {
		const tasks = w.tasks.map(t => ({
			id: t.id,
			label: `${t.id} ${t.title}`,
			checked: t.checked,
		}));
		const checked = tasks.filter(t => t.checked).length;
		return {
			key: String(w.key),
			title: w.title,
			total: tasks.length,
			checked,
			isCurrent: false,
			tasks,
		};
	});

	// Determine current wave
	const nonClosing = result.filter(w => w.key !== "closing");
	const firstIncomplete = nonClosing.find(w => w.checked < w.total);
	if (firstIncomplete) {
		firstIncomplete.isCurrent = true;
	} else {
		const closing = result.find(w => w.key === "closing");
		if (closing && closing.checked < closing.total) closing.isCurrent = true;
	}

	return result;
}

// --- Load tasks ---

export function loadTasks(projPath: string, projName: string, opts?: { showAll?: boolean }): TaskInfo[] {
	const state = readActiveState(projPath);
	const tasks: TaskInfo[] = state.tasks.map(task => buildTaskInfo(projPath, projName, task));

	if (opts?.showAll) {
		for (const task of readCompleteState(projPath).tasks) {
			tasks.push(buildTaskInfo(projPath, projName, task));
		}
		for (const task of readCancelState(projPath).tasks) {
			tasks.push(buildTaskInfo(projPath, projName, task));
		}
	}

	return tasks;
}

function buildTaskInfo(projPath: string, projName: string, task: TaskEntry): TaskInfo {
	let waves: WaveInfo[] = [];
	let focus = "";
	let completed = 0;
	let total = 0;

	try {
		const raw = readFileSync(join(projPath, ".alfred", "specs", task.slug, "tasks.json"), "utf-8");
		const data: TasksJson = JSON.parse(raw);
		waves = jsonToWaves(data);
		for (const w of waves) { completed += w.checked; total += w.total; }
		const cur = waves.find(w => w.isCurrent);
		if (cur) focus = cur.title;
	} catch {
		// No tasks.json — for completed/cancelled specs, show as 100%
		if (task.status === "completed" || task.status === "cancelled") {
			completed = 1;
			total = 1;
		}
	}

	return {
		slug: task.slug,
		status: task.status ?? "active",
		size: task.size ?? "M",
		specType: task.spec_type ?? "feature",
		startedAt: task.started_at ?? "",
		focus,
		completed,
		total,
		waves,
		projectName: projName,
	};
}

// --- Project resolution ---

export function resolveProject(store: Store): { path: string; name: string } {
	const cwd = process.cwd();
	// Try cwd first — even without DB registration, if .alfred/ exists here, use it
	if (existsSync(join(cwd, ".alfred", "specs", "_active.json")) || existsSync(join(cwd, ".alfred", "specs"))) {
		const row = store.db.prepare("SELECT name FROM projects WHERE path = ? LIMIT 1").get(cwd) as { name: string } | undefined;
		return { path: cwd, name: row?.name ?? cwd.split("/").pop() ?? "project" };
	}
	// Fall back to DB registered projects
	const row = store.db.prepare("SELECT id, name, path FROM projects WHERE path = ? AND status = 'active' LIMIT 1").get(cwd) as { id: string; name: string; path: string } | undefined;
	if (row) return { path: row.path, name: row.name };
	try {
		const fallback = store.db.prepare("SELECT id, name, path FROM projects WHERE status = 'active' ORDER BY rowid DESC LIMIT 1").get() as { id: string; name: string; path: string } | undefined;
		if (fallback) return { path: fallback.path, name: fallback.name };
	} catch { /* last_seen_at may not exist */ }
	return { path: cwd, name: cwd.split("/").pop() ?? "unknown" };
}
