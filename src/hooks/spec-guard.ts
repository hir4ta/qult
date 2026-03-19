import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readActiveState } from "../spec/types.js";

export interface SpecState {
	slug: string;
	size: string;
	reviewStatus: string;
	status: string;
}

const VALID_SIZES = new Set(["S", "M", "L", "XL", "D", ""]);
const VALID_REVIEW_STATUSES = new Set(["pending", "approved", "changes_requested", ""]);

/**
 * Read active spec state from _active.md via proper YAML parsing.
 * Returns null on any error (NFR-2: fail-open).
 */
export function tryReadActiveSpec(cwd: string | undefined): SpecState | null {
	if (!cwd) return null;
	try {
		return parseSpecState(cwd);
	} catch {
		return null; // NFR-2: fail-open
	}
}

/**
 * Check if _active.md exists but cannot be parsed or has invalid enum values.
 * Used by PreToolUse to deny edits instead of silently allowing.
 */
export function isActiveSpecMalformed(cwd: string | undefined): boolean {
	if (!cwd) return false;
	const path = join(cwd, ".alfred", "specs", "_active.md");
	if (!existsSync(path)) return false;
	try {
		return parseSpecState(cwd) === null;
	} catch {
		return true; // file exists but can't be read/parsed
	}
}

/** Shared parsing logic — single readActiveState call for both functions. */
function parseSpecState(cwd: string): SpecState | null {
	const state = readActiveState(cwd);
	if (!state.primary) return null;
	const task = state.tasks.find((t) => t.slug === state.primary);
	if (!task) return null;
	const size = task.size ?? "";
	const reviewStatus = task.review_status ?? "pending";
	const status = task.status ?? "pending";
	// Enum validation: reject unknown values.
	if (!VALID_SIZES.has(size)) return null;
	if (!VALID_REVIEW_STATUSES.has(reviewStatus)) return null;
	return { slug: task.slug, size, reviewStatus, status };
}

/**
 * Check if file_path is under .alfred/ directory (spec/config files should not be blocked).
 */
export function isSpecFilePath(cwd: string | undefined, filePath: string): boolean {
	if (!cwd || !filePath) return false;
	const resolved = resolve(cwd, filePath);
	const alfredDir = join(cwd, ".alfred");
	return resolved.startsWith(`${alfredDir}/`) || resolved === alfredDir;
}

/**
 * Count unchecked task checkboxes (`- [ ]`) in tasks.md.
 */
export function countUncheckedTasks(cwd: string | undefined, slug: string): number {
	if (!cwd) return 0;
	try {
		const tasks = readFileSync(join(cwd, ".alfred", "specs", slug, "tasks.md"), "utf-8");
		return (tasks.match(/^- \[ \] /gm) ?? []).length;
	} catch {
		return 0;
	}
}

/**
 * Check if tasks.md has unchecked self-review items.
 */
export function hasUncheckedSelfReview(cwd: string | undefined, slug: string): boolean {
	if (!cwd) return false;
	try {
		const tasks = readFileSync(join(cwd, ".alfred", "specs", slug, "tasks.md"), "utf-8");
		return tasks.split("\n").some(
			(line) =>
				line.startsWith("- [ ] ") && (/セルフレビュー/i.test(line) || /self-review/i.test(line)),
		);
	} catch {
		return false;
	}
}

/**
 * PreToolUse: deny tool via permissionDecision JSON (exit 0).
 */
export function denyTool(reason: string): void {
	const out = {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
	process.stdout.write(`${JSON.stringify(out)}\n`);
}

/**
 * Stop: block Claude from stopping via decision JSON.
 */
export function blockStop(reason: string): void {
	const out = { decision: "block", reason };
	process.stdout.write(`${JSON.stringify(out)}\n`);
}
