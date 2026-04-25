/**
 * `qult add-agent <key>` — append a single integration to an already
 * initialized qult project. Requires init to have run first.
 *
 * Refuses to overwrite existing files unless `--force` is given.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GenerationContext } from "../../integrations/base.ts";
import { listIntegrationKeys, resolveIntegration } from "../../integrations/registry.ts";
import { atomicWrite } from "../../state/fs.ts";
import { configJsonPath } from "../../state/paths.ts";
import { writeAgentsMd } from "../../templates/agents-md.ts";
import { findTemplateRoot } from "../paths.ts";
import { isTTY } from "../prompt.ts";

declare const __QULT_VERSION__: string;
const VERSION = typeof __QULT_VERSION__ !== "undefined" ? __QULT_VERSION__ : "0.0.0-dev";

export interface AddAgentOptions {
	key?: string;
	force?: boolean;
	json?: boolean;
}

export async function runAddAgent(opts: AddAgentOptions): Promise<number> {
	const projectRoot = process.cwd();
	const key = opts.key;
	if (!key) {
		process.stderr.write(
			`add-agent: missing integration key\navailable: ${listIntegrationKeys().join(", ")}\n`,
		);
		return 1;
	}
	const integ = resolveIntegration(key);
	if (!integ) {
		process.stderr.write(
			`add-agent: unknown integration "${key}"\navailable: ${listIntegrationKeys().join(", ")}\n`,
		);
		return 1;
	}

	if (!opts.force && hasIntegrationFiles(projectRoot, key)) {
		process.stderr.write(
			`add-agent: ${key} configuration already exists (re-run with --force to overwrite)\n`,
		);
		return 1;
	}

	const templateRoot = findTemplateRoot();
	const ctx: GenerationContext = {
		projectRoot,
		templateRoot,
		vars: { QULT_VERSION: VERSION },
		force: opts.force ?? false,
		interactive: isTTY(),
	};
	await writeAgentsMd({ projectRoot, templateRoot, qultVersion: VERSION });
	await integ.generateConfigFiles(ctx);
	await integ.registerMcpServer(ctx);
	appendEnabledIntegration(key);

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, added: key })}\n`);
	} else {
		process.stdout.write(`✔ added integration: ${key}\n`);
	}
	return 0;
}

function hasIntegrationFiles(projectRoot: string, key: string): boolean {
	switch (key) {
		case "claude":
			return existsSync(join(projectRoot, ".mcp.json"));
		case "cursor":
			return existsSync(join(projectRoot, ".cursor/mcp.json"));
		case "gemini":
			return existsSync(join(projectRoot, ".gemini/settings.json"));
		case "codex":
			return existsSync(join(projectRoot, ".codex/config.toml"));
		default:
			return false;
	}
}

function appendEnabledIntegration(key: string): void {
	const path = configJsonPath();
	let raw: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch {
			raw = {};
		}
	}
	const ints = (raw.integrations as Record<string, unknown> | undefined) ?? {};
	const currentEnabled = Array.isArray(ints.enabled)
		? (ints.enabled as unknown[]).filter((k): k is string => typeof k === "string")
		: [];
	if (!currentEnabled.includes(key)) currentEnabled.push(key);
	ints.enabled = currentEnabled;
	raw.integrations = ints;
	atomicWrite(path, `${JSON.stringify(raw, null, 2)}\n`);
}
