/**
 * Active spec detection, archive operations, wave file lifecycle, and
 * Range-SHA reachability helpers.
 *
 * The "active spec" is the single non-archived spec under `.qult/specs/`. If
 * there is none, the project has no active spec (e.g. a fresh `main` after
 * `/qult:finish`). Multiple non-archived specs are an error condition that
 * surfaces during `/qult:status` / `get_active_spec`.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "./fs.ts";
import {
	archiveDir,
	assertConfinedToQult,
	assertValidSpecName,
	designPath,
	requirementsPath,
	specDir,
	specsDir,
	tasksPath,
	wavePath,
	wavesDir,
} from "./paths.ts";

/** Lightweight summary of a spec's on-disk state. */
export interface ActiveSpecInfo {
	name: string;
	path: string;
	hasRequirements: boolean;
	hasDesign: boolean;
	hasTasks: boolean;
	wavesDirExists: boolean;
}

/** List directory entries that are direct child specs (excluding archive/). */
export function listSpecNames(): string[] {
	const root = specsDir();
	if (!existsSync(root)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name === "archive") continue;
		// Quietly skip names that wouldn't pass spec_name validation — they
		// can't have been created by qult and shouldn't be promoted to active.
		try {
			assertValidSpecName(entry.name);
		} catch {
			continue;
		}
		out.push(entry.name);
	}
	return out.sort();
}

/**
 * Return the unique active spec, or null if none. Throws if more than one
 * non-archived spec exists (caller decides how to handle the inconsistency).
 */
export function getActiveSpec(): ActiveSpecInfo | null {
	const names = listSpecNames();
	if (names.length === 0) return null;
	if (names.length > 1) {
		throw new Error(
			`multiple active specs detected: ${names.join(", ")} — only one non-archived spec is allowed`,
		);
	}
	const name = names[0]!;
	const path = specDir(name);
	return {
		name,
		path,
		hasRequirements: existsSync(requirementsPath(name)),
		hasDesign: existsSync(designPath(name)),
		hasTasks: existsSync(tasksPath(name)),
		wavesDirExists: existsSync(wavesDir(name)),
	};
}

/** List archived spec directories under `.qult/specs/archive/`. */
export function listArchivedSpecs(): string[] {
	const root = archiveDir();
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

/**
 * Move `.qult/specs/<name>/` → `.qult/specs/archive/<name>[-YYYYMMDD-HHMMSS]/`.
 *
 * Adds a timestamp suffix when the destination already exists. Caller is
 * responsible for creating the git commit that records the rename.
 */
export function archiveSpec(name: string, now: Date = new Date()): string {
	assertValidSpecName(name);
	const src = specDir(name);
	if (!existsSync(src)) {
		throw new Error(`spec not found: ${name}`);
	}
	ensureDir(archiveDir());
	let dest = `${archiveDir()}/${name}`;
	if (existsSync(dest)) {
		dest = `${archiveDir()}/${name}-${formatTimestamp(now)}`;
	}
	assertConfinedToQult(dest);
	ensureDir(dirname(dest));
	renameSync(src, dest);
	return dest;
}

function formatTimestamp(d: Date): string {
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const mi = String(d.getUTCMinutes()).padStart(2, "0");
	const ss = String(d.getUTCSeconds()).padStart(2, "0");
	return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/** Path to a Wave file, ensuring the parent waves/ dir exists. */
export function wavePathEnsured(name: string, waveNum: number): string {
	const p = wavePath(name, waveNum);
	ensureDir(wavesDir(name));
	return p;
}

/** List existing wave files for a spec, returned as ordered Wave numbers. */
export function listWaveNumbers(name: string): number[] {
	const dir = wavesDir(name);
	if (!existsSync(dir)) return [];
	const re = /^wave-(\d{2})\.md$/;
	const nums: number[] = [];
	for (const entry of readdirSync(dir)) {
		const m = re.exec(entry);
		if (m?.[1]) {
			nums.push(Number.parseInt(m[1], 10));
		}
	}
	return nums.sort((a, b) => a - b);
}

/** Return true iff `<sha>^{commit}` resolves successfully. */
export function isCommitReachable(sha: string, cwd?: string): boolean {
	if (!/^[0-9a-f]{4,40}$/.test(sha)) return false;
	try {
		execSync(`git rev-parse --verify ${sha}^{commit}`, {
			cwd: cwd ?? process.cwd(),
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

/** Parse `start..end` and verify both ends are reachable. */
export function isRangeReachable(range: string, cwd?: string): boolean {
	const m = /^([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})$/.exec(range);
	if (!m) return false;
	return isCommitReachable(m[1]!, cwd) && isCommitReachable(m[2]!, cwd);
}

/** Get current HEAD SHA. Throws if `git rev-parse HEAD` fails. */
export function gitHeadSha(cwd?: string): string {
	const out = execSync("git rev-parse HEAD", {
		cwd: cwd ?? process.cwd(),
		stdio: ["ignore", "pipe", "ignore"],
	});
	return out.toString("utf8").trim();
}
