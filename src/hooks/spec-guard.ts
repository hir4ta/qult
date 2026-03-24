import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readActiveState } from "../spec/types.js";

interface SpecState {
	slug: string;
	status: string;
	size: string;
	specType: string;
}

function parseSpecState(cwd: string): SpecState | null {
	const state = readActiveState(cwd);
	if (!state.primary) return null;
	const task = state.tasks.find((t) => t.slug === state.primary);
	if (!task) return null;
	return {
		slug: state.primary,
		status: task.status ?? "pending",
		size: task.size ?? "M",
		specType: task.spec_type ?? "feature",
	};
}

export function tryReadActiveSpec(cwd: string | undefined): SpecState | null {
	if (!cwd) return null;
	try {
		return parseSpecState(cwd);
	} catch {
		return null; // NFR-2: fail-open
	}
}

/**
 * Check if _active.json exists but cannot be parsed or has invalid state.
 * Used by PreToolUse to deny edits instead of silently allowing.
 */
export function isActiveSpecMalformed(cwd: string | undefined): boolean {
	if (!cwd) return false;
	const path = join(cwd, ".alfred", "specs", "_active.json");
	if (!existsSync(path)) return false;
	try {
		const state = readActiveState(cwd);
		if (!state.primary) return false;
		return parseSpecState(cwd) === null;
	} catch {
		return true;
	}
}

export function isSpecFilePath(cwd: string | undefined, filePath: string): boolean {
	if (!cwd || !filePath) return false;
	const resolved = resolve(cwd, filePath);
	const alfredDir = join(cwd, ".alfred");
	return resolved.startsWith(`${alfredDir}/`) || resolved === alfredDir;
}

export function allowTool(reason: string): void {
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow", permissionDecisionReason: reason } }) + "\n");
}

export function denyTool(reason: string): void {
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n");
}

export function blockStop(reason: string): void {
	process.stderr.write(`[CONTEXT] ${reason}\n`);
}
