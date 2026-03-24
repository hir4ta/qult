import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Hook state persistence — stores session-local state in .alfred/.state/
 * instead of /tmp to avoid cross-project collisions and OS reboot data loss.
 *
 * All reads are fail-open (return fallback on error).
 * All writes are best-effort (silently swallow errors).
 */

export function stateDir(cwd: string): string {
	return join(cwd, ".alfred", ".state");
}

export function ensureStateDir(cwd: string): void {
	mkdirSync(stateDir(cwd), { recursive: true });
}

function validateName(name: string): void {
	if (!name || name === "." || name.includes("/") || name.includes("\\") || name.includes("..")) {
		throw new Error(`invalid state file name: ${name}`);
	}
}

export function readStateJSON<T>(cwd: string, name: string, fallback: T): T {
	try {
		validateName(name);
		const raw = readFileSync(join(stateDir(cwd), name), "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export function writeStateJSON(cwd: string, name: string, data: unknown): void {
	try {
		validateName(name);
		ensureStateDir(cwd);
		writeFileSync(join(stateDir(cwd), name), JSON.stringify(data));
	} catch {
		/* best effort */
	}
}

// --- Session-scoped worked slugs tracking ---

const WORKED_SLUGS_FILE = "worked-slugs.json";

/** Read the list of spec slugs worked on in this session. */
export function readWorkedSlugs(cwd: string): string[] {
	const data = readStateJSON<string[]>(cwd, WORKED_SLUGS_FILE, []);
	return Array.isArray(data) ? data : [];
}

/** Add a slug to the worked-slugs list (deduplicates). */
export function addWorkedSlug(cwd: string, slug: string): void {
	const slugs = readWorkedSlugs(cwd);
	if (!slugs.includes(slug)) {
		slugs.push(slug);
		writeStateJSON(cwd, WORKED_SLUGS_FILE, slugs);
	}
}

/** Reset worked-slugs at session start. */
export function resetWorkedSlugs(cwd: string): void {
	writeStateJSON(cwd, WORKED_SLUGS_FILE, []);
}

// --- Wave progress tracking ---

const WAVE_PROGRESS_FILE = "wave-progress.json";

export interface WaveState {
	total: number;
	checked: number;
	reviewed: boolean;
}

export interface WaveProgress {
	slug: string;
	current_wave: number;
	waves: Record<string, WaveState>;
}

/** Read wave progress for the active spec. Returns null if not tracked yet. */
export function readWaveProgress(cwd: string): WaveProgress | null {
	return readStateJSON<WaveProgress | null>(cwd, WAVE_PROGRESS_FILE, null);
}

/** Write wave progress state. */
export function writeWaveProgress(cwd: string, progress: WaveProgress): void {
	writeStateJSON(cwd, WAVE_PROGRESS_FILE, progress);
}

