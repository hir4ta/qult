/**
 * `qult update` — refresh integration config files and AGENTS.md from the
 * latest bundled templates. The @generated marker block is replaced; user
 * content outside the marker is preserved.
 *
 * Does NOT touch `.qult/specs/` or `.qult/state/`.
 */

import type { GenerationContext } from "../../integrations/base.ts";
import { resolveIntegration } from "../../integrations/registry.ts";
import { readEnabledIntegrations } from "../../state/config-io.ts";
import { writeAgentsMd } from "../../templates/agents-md.ts";
import { findTemplateRoot } from "../paths.ts";
import { isTTY } from "../prompt.ts";

declare const __QULT_VERSION__: string;
const VERSION = typeof __QULT_VERSION__ !== "undefined" ? __QULT_VERSION__ : "0.0.0-dev";

export interface UpdateOptions {
	json?: boolean;
}

export async function runUpdate(opts: UpdateOptions): Promise<number> {
	const projectRoot = process.cwd();
	const enabled = readEnabledIntegrations();
	if (enabled.length === 0) {
		process.stderr.write(
			"update: no integrations enabled in .qult/config.json (run 'qult init' first)\n",
		);
		return 1;
	}

	const templateRoot = findTemplateRoot();
	await writeAgentsMd({ projectRoot, templateRoot, qultVersion: VERSION });

	const ctx: GenerationContext = {
		projectRoot,
		templateRoot,
		vars: { QULT_VERSION: VERSION },
		force: true,
		interactive: isTTY(),
	};
	const refreshed: string[] = [];
	for (const key of enabled) {
		const integ = resolveIntegration(key);
		if (!integ) continue;
		await integ.generateConfigFiles(ctx);
		await integ.registerMcpServer(ctx);
		refreshed.push(key);
	}

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, refreshed, version: VERSION })}\n`);
	} else {
		process.stdout.write(
			`✔ refreshed ${refreshed.length} integration(s): ${refreshed.join(", ")}\n`,
		);
	}
	return 0;
}
