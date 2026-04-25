/**
 * Resolve the MCP server spawn command based on how this CLI was invoked.
 *
 * - When the running `cli.js` lives inside an npx temp dir (`.../_npx/...`),
 *   the user invoked qult via `npx -y @hir4ta/qult init` and probably has no
 *   stable `qult` binary on PATH. Register the MCP server as `npx -y` so
 *   later AI-tool sessions can still spawn it.
 * - Otherwise the CLI lives in a stable location (global install,
 *   `node_modules/.bin/qult`, or local checkout). Register as bare `qult mcp`
 *   so the AI tool gets a fast, network-free spawn each session.
 *
 * The architect can override either decision by editing the generated config
 * files; this function only chooses a sensible default.
 */

import { fileURLToPath } from "node:url";

export interface McpCommand {
	command: string;
	args: string[];
}

export const NPX_FALLBACK: McpCommand = {
	command: "npx",
	args: ["-y", "@hir4ta/qult", "mcp"],
};

export const QULT_DIRECT: McpCommand = {
	command: "qult",
	args: ["mcp"],
};

/**
 * Decide the MCP spawn command for newly generated config files.
 *
 * Detection is based on the currently-executing CLI's path. The override
 * `QULT_FORCE_NPX_MCP=1` env var pins the npx form (useful for tests).
 */
export function resolveMcpCommand(): McpCommand {
	if (process.env.QULT_FORCE_NPX_MCP === "1") return NPX_FALLBACK;
	if (process.env.QULT_FORCE_DIRECT_MCP === "1") return QULT_DIRECT;
	let cliPath = "";
	try {
		cliPath = fileURLToPath(import.meta.url);
	} catch {
		return NPX_FALLBACK;
	}
	// npx caches packages under `<npm-cache>/_npx/<hash>/...`. If we're
	// running from there, the install is ephemeral — prefer npx for the
	// generated config so future spawns refetch as needed.
	if (cliPath.includes("/_npx/") || cliPath.includes("\\_npx\\")) return NPX_FALLBACK;
	return QULT_DIRECT;
}
