/**
 * Data layer for TUI — reads directly from filesystem.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../store/index.js";

const VALID_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

// --- Active state parser ---

function readActiveState(projPath: string): { primary: string; tasks: Array<{ slug: string; status?: string; started_at?: string; size?: string; spec_type?: string }> } {
	const activePath = join(projPath, ".alfred", "specs", "_active.md");
	if (!existsSync(activePath)) return { primary: "", tasks: [] };

	const content = readFileSync(activePath, "utf-8");
	type Task = { slug: string; status?: string; started_at?: string; size?: string; spec_type?: string };
	const tasks: Task[] = [];
	let primary = "";
	let current: Task | null = null;

	for (const line of content.split("\n")) {
		const primaryMatch = line.match(/^primary:\s*(.+)/);
		if (primaryMatch) {
			primary = primaryMatch[1]!.trim().replace(/^["']|["']$/g, "");
			continue;
		}
		const slugMatch = line.match(/^\s+-\s+slug:\s*(.+)/);
		if (slugMatch) {
			current = { slug: slugMatch[1]!.trim() };
			tasks.push(current);
			continue;
		}
		if (current) {
			const kv = line.match(/^\s+(\w+):\s*(.+)/);
			if (kv) {
				const [, key, val] = kv;
				const v = val!.trim();
				if (key === "status") current.status = v;
				else if (key === "started_at") current.started_at = v;
				else if (key === "size") current.size = v;
				else if (key === "spec_type") current.spec_type = v;
			}
		}
	}

	return { primary, tasks };
}

// --- Wave + task parser ---

function parseWaves(content: string): WaveInfo[] {
	const waves: Array<{ key: string; title: string; total: number; checked: number; tasks: TaskItem[] }> = [];
	let current: (typeof waves)[number] | null = null;

	for (const line of content.split("\n")) {
		const waveMatch = line.match(/^## Wave\s+(\d+)(?::\s*(.+))?/i);
		const closingMatch = line.match(/^## (?:Wave:\s*)?Closing(?:\s+Wave)?/i);

		if (waveMatch) {
			current = { key: waveMatch[1]!, title: waveMatch[2]?.trim() || `Wave ${waveMatch[1]}`, total: 0, checked: 0, tasks: [] };
			waves.push(current);
		} else if (closingMatch) {
			current = { key: "closing", title: "Closing", total: 0, checked: 0, tasks: [] };
			waves.push(current);
		} else if (current && /^- \[[ xX]\] /.test(line)) {
			const isChecked = /^- \[[xX]\] /.test(line);
			const label = line.replace(/^- \[[ xX]\] /, "").trim();
			// Extract task ID (e.g., "T-1.2 Do something" → id="T-1.2", label="Do something")
			const idMatch = label.match(/^(T-\d+\.\d+)\s+(.*)/);
			const id = idMatch ? idMatch[1]! : label.slice(0, 10);
			const displayLabel = idMatch ? `${idMatch[1]} ${idMatch[2]}` : label;

			current.total++;
			if (isChecked) current.checked++;
			current.tasks.push({ id, label: displayLabel, checked: isChecked });
		}
	}

	// Determine current wave
	let currentKey = "";
	const nonClosing = waves.filter((w) => w.key !== "closing");
	const firstIncomplete = nonClosing.find((w) => w.checked < w.total);
	if (firstIncomplete) {
		currentKey = firstIncomplete.key;
	} else {
		const closing = waves.find((w) => w.key === "closing");
		if (closing && closing.checked < closing.total) currentKey = "closing";
	}

	return waves.map((w) => ({ ...w, isCurrent: w.key === currentKey }));
}

// --- Load tasks ---

export function loadTasks(projPath: string, projName: string): TaskInfo[] {
	const state = (() => {
		try { return readActiveState(projPath); } catch { return { primary: "", tasks: [] }; }
	})();

	return state.tasks.map((task) => {
		let waves: WaveInfo[] = [];
		let focus = "";
		let completed = 0;
		let total = 0;

		try {
			const tasksContent = readFileSync(join(projPath, ".alfred", "specs", task.slug, "tasks.md"), "utf-8");
			waves = parseWaves(tasksContent);
			for (const w of waves) { completed += w.checked; total += w.total; }
			const cur = waves.find((w) => w.isCurrent);
			if (cur) focus = cur.title;
		} catch { /* no tasks.md */ }

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
	});
}

// --- Project resolution ---

export function resolveProject(store: Store): { path: string; name: string } {
	const cwd = process.cwd();
	// Try cwd first — even without DB registration, if .alfred/ exists here, use it
	if (existsSync(join(cwd, ".alfred", "specs", "_active.md"))) {
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
