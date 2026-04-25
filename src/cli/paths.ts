/**
 * Resolve runtime paths for the bundled CLI:
 *  - templateRoot: where the agent-neutral templates live (`src/templates/bundled/`)
 *  - mcpServerEntry: path to the bundled `dist/mcp-server.js` for the `mcp` subcommand
 *
 * Both are derived from `import.meta.url` so they work in both source mode
 * (running through tsx / vitest) and bundled mode (`node dist/cli.js`).
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function thisDir(): string {
	return dirname(fileURLToPath(import.meta.url));
}

/**
 * Locate the bundled templates directory.
 *
 * Layout when published: `<package>/dist/cli.js` and `<package>/src/templates/bundled/`.
 * Layout in dev (vitest): `src/cli/index.ts` and `src/templates/bundled/` are siblings.
 */
export function findTemplateRoot(): string {
	const here = thisDir();
	const candidates = [
		resolve(here, "../templates/bundled"),
		resolve(here, "../../src/templates/bundled"),
		resolve(here, "../src/templates/bundled"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	throw new Error(`templates/bundled directory not found (searched: ${candidates.join(", ")})`);
}

/** Locate the bundled MCP server entrypoint. */
export function findMcpServerEntry(): string {
	const here = thisDir();
	const candidates = [resolve(here, "./mcp-server.js"), resolve(here, "../dist/mcp-server.js")];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	throw new Error(`mcp-server.js not found (searched: ${candidates.join(", ")})`);
}
