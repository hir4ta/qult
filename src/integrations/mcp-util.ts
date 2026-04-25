/**
 * Shared helper for integrations that register the qult MCP server in a JSON
 * config file (Claude `.mcp.json`, Cursor `.cursor/mcp.json`, Gemini
 * `.gemini/settings.json`). Centralizes:
 *  - read-merge-write JSON round-trip
 *  - validation that `mcpServers` is a plain object (rejects null / array /
 *    primitive — those would silently lose the registration on stringify)
 *  - path-traversal guard via assertConfinedToProject
 *
 * Codex uses TOML so it does not call this helper.
 */

import { existsSync, readFileSync } from "node:fs";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject } from "./base.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface JsonMcpServerEntry {
	type?: string;
	command: string;
	args: string[];
}

/**
 * Register or replace the qult MCP server entry in a JSON config file.
 *
 * Throws if the existing file's `mcpServers` field is non-null and not a
 * plain object — silently coercing `mcpServers: []` into a string-keyed
 * mutation would round-trip to a non-functional config.
 */
export function writeJsonMcpServer(
	configPath: string,
	key: string,
	entry: JsonMcpServerEntry,
	projectRoot: string,
): void {
	assertConfinedToProject(configPath, projectRoot);
	let existing: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		const raw = readFileSync(configPath, "utf8");
		const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			throw new Error(`refusing to overwrite ${configPath}: top-level value is not an object`);
		}
		existing = parsed;
	}
	let servers: Record<string, unknown>;
	if (existing.mcpServers === undefined) {
		servers = {};
	} else if (isPlainObject(existing.mcpServers)) {
		servers = existing.mcpServers;
	} else {
		throw new Error(
			`refusing to overwrite ${configPath}: mcpServers field exists but is not an object`,
		);
	}
	servers[key] = entry;
	existing.mcpServers = servers;
	atomicWriteAt(configPath, `${JSON.stringify(existing, null, 2)}\n`);
}
