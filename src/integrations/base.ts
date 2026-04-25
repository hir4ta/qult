/**
 * Integration Registry contract — every AI tool integration (claude, codex,
 * cursor, gemini, plus user-defined custom ones) implements this interface.
 *
 * The registry pattern is borrowed from spec-kit / OpenSpec: each integration
 * declares how to detect the tool, where to write its config files, and how
 * to register the qult MCP server in the tool's native config format.
 *
 * Path-traversal guard: `assertConfinedToProject` enforces that all writes
 * resolve under `projectRoot` so a malicious template cannot escape via
 * `..` segments or absolute paths.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type IntegrationKey = "claude" | "codex" | "cursor" | "gemini" | string;

export interface GenerationContext {
	/** Absolute path to the project root (the directory `.qult/` lives in). */
	projectRoot: string;
	/** Absolute path to the bundled-templates directory (or user override). */
	templateRoot: string;
	/** Substitution variables used by the `{{VAR}}` template renderer. */
	vars: Record<string, string>;
	/** When true, overwrite existing config files without prompting. */
	force: boolean;
	/** When true, the CLI may prompt the user (TTY); handlers must check before reading stdin. */
	interactive: boolean;
}

export interface IntegrationBase {
	/** Stable kebab-case identifier; used by `--agent <key>` and `add-agent <key>`. */
	readonly key: IntegrationKey;
	/** Human-readable name; shown in the interactive picker. */
	readonly displayName: string;
	/** Inspect `projectRoot` for the tool's marker directory or devDeps. */
	detect(projectRoot: string): boolean;
	/** Write the integration's command / rule files. Idempotent. */
	generateConfigFiles(ctx: GenerationContext): Promise<void>;
	/** Add the qult MCP server entry to the integration's MCP config file. */
	registerMcpServer(ctx: GenerationContext): Promise<void>;
}

/**
 * Reject any write target that doesn't resolve under `projectRoot`.
 *
 * Uses realpath so a symlink that points outside the project still fails.
 * Callers should pass an absolute path; we resolve relative paths against
 * `projectRoot` defensively.
 */
export function assertConfinedToProject(path: string, projectRoot: string): void {
	const target = resolve(isAbsolute(path) ? path : resolve(projectRoot, path));
	const realRoot = safeRealpath(projectRoot);
	// Walk up from the target until we hit an existing ancestor, realpath that,
	// then re-attach the never-existed leaf segments. This catches symlink
	// escapes via existing parent directories (e.g. `<projectRoot>/.cursor`
	// pre-created as a symlink to `/etc`).
	const realTarget = realpathDeepest(target);
	if (
		realTarget !== realRoot &&
		!realTarget.startsWith(`${realRoot}/`) &&
		realTarget !== resolve(projectRoot) &&
		!realTarget.startsWith(`${resolve(projectRoot)}/`)
	) {
		throw new Error(`path escape: ${path} resolves outside project root ${projectRoot}`);
	}
}

function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/** Realpath the deepest existing ancestor of `path`, then re-attach the missing leaves. */
function realpathDeepest(path: string): string {
	const segments: string[] = [];
	let cursor = path;
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		segments.unshift(cursor.slice(parent.length).replace(/^\//, ""));
		cursor = parent;
	}
	const realCursor = safeRealpath(cursor);
	return segments.length === 0 ? realCursor : resolve(realCursor, ...segments);
}
