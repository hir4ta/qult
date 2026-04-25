/**
 * Path resolution for the .qult/ project-local state directory.
 *
 * Single source of truth for where every spec / state / config file lives,
 * plus validators for `spec_name` and `wave_num` and a `confinedToQult` check
 * that uses `realpath` to ensure no operation escapes `.qult/`.
 *
 * No SQLite, no global config. All paths are derived from the current working
 * directory (project root).
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Reserved spec names that cannot be used. */
const RESERVED_SPEC_NAMES: ReadonlySet<string> = new Set(["archive"]);

/** Wave number bounds — kept here to avoid a circular dep on config.ts. */
export const WAVE_NUM_MIN = 1;
export const WAVE_NUM_MAX = 99;

/** kebab-case allowlist for spec names. Length 1..64, leading [a-z0-9]. */
const SPEC_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve the project root from cwd. Override-able for tests. */
let projectRootOverride: string | null = null;

/** Set the project root explicitly (test-only). */
export function setProjectRoot(root: string | null): void {
	projectRootOverride = root;
}

/** Project root used for path computation. Defaults to `process.cwd()`. */
export function getProjectRoot(): string {
	return projectRootOverride ?? process.cwd();
}

/** `.qult/` directory at project root. */
export function qultDir(): string {
	return resolve(getProjectRoot(), ".qult");
}

/** `.qult/specs/` directory. */
export function specsDir(): string {
	return resolve(qultDir(), "specs");
}

/** `.qult/specs/archive/` directory. */
export function archiveDir(): string {
	return resolve(specsDir(), "archive");
}

/** `.qult/specs/<name>/` for a validated spec name. */
export function specDir(name: string): string {
	assertValidSpecName(name);
	return resolve(specsDir(), name);
}

/** `.qult/specs/<name>/requirements.md` */
export function requirementsPath(name: string): string {
	return resolve(specDir(name), "requirements.md");
}

/** `.qult/specs/<name>/design.md` */
export function designPath(name: string): string {
	return resolve(specDir(name), "design.md");
}

/** `.qult/specs/<name>/tasks.md` */
export function tasksPath(name: string): string {
	return resolve(specDir(name), "tasks.md");
}

/** `.qult/specs/<name>/waves/` directory. */
export function wavesDir(name: string): string {
	return resolve(specDir(name), "waves");
}

/** `.qult/specs/<name>/waves/wave-NN.md` (NN is always 2-digit zero-padded). */
export function wavePath(name: string, waveNum: number): string {
	assertValidWaveNum(waveNum);
	return resolve(wavesDir(name), `wave-${formatWaveNum(waveNum)}.md`);
}

/** Format wave number as 2-digit zero-padded string. */
export function formatWaveNum(waveNum: number): string {
	assertValidWaveNum(waveNum);
	return String(waveNum).padStart(2, "0");
}

/** `.qult/state/` directory (gitignored). */
export function stateDir(): string {
	return resolve(qultDir(), "state");
}

/** `.qult/state/current.json` */
export function currentJsonPath(): string {
	return resolve(stateDir(), "current.json");
}

/** `.qult/state/pending-fixes.json` */
export function pendingFixesJsonPath(): string {
	return resolve(stateDir(), "pending-fixes.json");
}

/** `.qult/state/stage-scores.json` */
export function stageScoresJsonPath(): string {
	return resolve(stateDir(), "stage-scores.json");
}

/** `.qult/config.json` (committed) */
export function configJsonPath(): string {
	return resolve(qultDir(), "config.json");
}

/** Project `.gitignore` */
export function gitignorePath(): string {
	return resolve(getProjectRoot(), ".gitignore");
}

// --- validators ---

/** Throw if `name` is not a valid spec name (kebab-case, not reserved). */
export function assertValidSpecName(name: string): void {
	if (typeof name !== "string" || !SPEC_NAME_RE.test(name)) {
		throw new Error(
			`invalid spec name: ${JSON.stringify(name)} (must match ${SPEC_NAME_RE} and be ≤64 chars)`,
		);
	}
	if (RESERVED_SPEC_NAMES.has(name)) {
		throw new Error(`reserved spec name: ${JSON.stringify(name)}`);
	}
	if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
		throw new Error(`spec name must not contain path separators or leading dot: ${name}`);
	}
}

/** Boolean form of {@link assertValidSpecName}. */
export function isValidSpecName(name: string): boolean {
	try {
		assertValidSpecName(name);
		return true;
	} catch {
		return false;
	}
}

/** Throw if `waveNum` is not a positive integer in [1, 99]. */
export function assertValidWaveNum(waveNum: number): void {
	if (!Number.isInteger(waveNum) || waveNum < WAVE_NUM_MIN || waveNum > WAVE_NUM_MAX) {
		throw new Error(
			`invalid wave_num: ${waveNum} (must be integer in [${WAVE_NUM_MIN}, ${WAVE_NUM_MAX}])`,
		);
	}
}

/**
 * Resolve `targetPath` and assert that the resolved real path is contained
 * within `.qult/` of the current project. Throws on any escape attempt.
 *
 * If the target does not yet exist on disk, walks up the parent chain to
 * find the deepest existing ancestor and resolves that — the canonicalized
 * ancestor must still be within `.qult/`. This blocks symlinks anywhere in
 * the chain that would redirect the resolution outside.
 */
export function assertConfinedToQult(targetPath: string): string {
	const resolved = resolve(targetPath);
	// Use resolveExistingAncestor on both sides so the check works even when
	// .qult/ has not been created yet (fresh project, audit log written before
	// any explicit init). Both sides resolve via existing ancestors, so symlinks
	// anywhere in the chain are still followed and detected.
	const qultRealPath = resolveExistingAncestor(qultDir());
	const targetRealPath = resolveExistingAncestor(resolved);
	if (targetRealPath !== qultRealPath && !targetRealPath.startsWith(`${qultRealPath}/`)) {
		throw new Error(
			`path escape detected: ${targetPath} resolves to ${targetRealPath}, outside ${qultRealPath}`,
		);
	}
	return resolved;
}

/** Walk up the parent chain to the deepest existing path and realpath that. */
function resolveExistingAncestor(absPath: string): string {
	let current = absPath;
	for (let i = 0; i < 64; i++) {
		try {
			return realpathSync(current);
		} catch {
			const parent = resolve(current, "..");
			if (parent === current) {
				// reached filesystem root without finding any existing ancestor
				return current;
			}
			current = parent;
		}
	}
	throw new Error(`unable to resolve real path for ${absPath} (parent chain exhausted)`);
}
