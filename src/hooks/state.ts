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

export function readStateText(cwd: string, name: string, fallback: string): string {
	try {
		validateName(name);
		return readFileSync(join(stateDir(cwd), name), "utf-8");
	} catch {
		return fallback;
	}
}

export function writeStateText(cwd: string, name: string, data: string): void {
	try {
		validateName(name);
		ensureStateDir(cwd);
		writeFileSync(join(stateDir(cwd), name), data);
	} catch {
		/* best effort */
	}
}

// --- Intent state for spec-first enforcement ---

/** Intents that require an active spec before source edits. Shared between UserPromptSubmit and PreToolUse. */
export const IMPLEMENT_INTENTS = new Set(["implement", "bugfix", "tdd"]);

const INTENT_FILE = "last-intent.json";
const INTENT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

interface IntentState {
	intent: string;
	timestamp: number;
}

export function writeLastIntent(cwd: string, intent: string | null): void {
	if (!intent) {
		writeStateJSON(cwd, INTENT_FILE, null);
		return;
	}
	writeStateJSON(cwd, INTENT_FILE, { intent, timestamp: Date.now() } satisfies IntentState);
}

export function readLastIntent(cwd: string): string | null {
	const data = readStateJSON<IntentState | null>(cwd, INTENT_FILE, null);
	if (!data || !data.intent || !data.timestamp) return null;
	if (Date.now() - data.timestamp > INTENT_EXPIRY_MS) return null; // expired
	return data.intent;
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
