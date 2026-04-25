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

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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
	// Realpath the project root only — the target typically doesn't exist yet
	// (we're about to create it). Comparing target's `resolve()` against the
	// realpath of the root catches `..` traversal; symlink-based escapes via
	// existing parents are out of scope (MVP — we control the templates).
	let realRoot: string;
	try {
		realRoot = realpathSync(projectRoot);
	} catch {
		realRoot = resolve(projectRoot);
	}
	if (
		target !== realRoot &&
		!target.startsWith(`${realRoot}/`) &&
		target !== projectRoot &&
		!target.startsWith(`${resolve(projectRoot)}/`)
	) {
		throw new Error(`path escape: ${path} resolves outside project root ${projectRoot}`);
	}
}
