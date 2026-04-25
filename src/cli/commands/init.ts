/**
 * `qult init` — bootstrap qult in the current project.
 *
 * Steps (in order):
 *  1. Choose integrations (--agent flag, auto-detect, or interactive prompt).
 *  2. Write AGENTS.md (with @generated marker block).
 *  3. For each chosen integration: generateConfigFiles + registerMcpServer.
 *  4. Persist `integrations.enabled` to `.qult/config.json`.
 *  5. Initialize the `.qult/` directory layout (specs/ subdir).
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GenerationContext } from "../../integrations/base.ts";
import {
	detectIntegrations,
	listIntegrations,
	resolveIntegration,
} from "../../integrations/registry.ts";
import { updateEnabledIntegrations } from "../../state/config-io.ts";
import { qultDir, specsDir } from "../../state/paths.ts";
import { writeAgentsMd } from "../../templates/agents-md.ts";
import { findTemplateRoot } from "../paths.ts";
import { confirm, isTTY, selectMany } from "../prompt.ts";

declare const __QULT_VERSION__: string;
const VERSION = typeof __QULT_VERSION__ !== "undefined" ? __QULT_VERSION__ : "0.0.0-dev";

export interface InitOptions {
	/** Restrict to a single integration key (skip auto-detect). */
	agent?: string;
	/** Overwrite existing files without prompting. */
	force?: boolean;
	/** Emit JSON summary instead of human-readable. */
	json?: boolean;
}

export async function runInit(opts: InitOptions): Promise<number> {
	const projectRoot = process.cwd();
	const tty = isTTY();

	// 1. Choose integrations.
	let chosen: string[];
	if (opts.agent) {
		const i = resolveIntegration(opts.agent);
		if (!i) {
			const available = listIntegrations()
				.map((x) => x.key)
				.join(", ");
			process.stderr.write(`unknown integration: ${opts.agent}\navailable: ${available}\n`);
			return 1;
		}
		chosen = [opts.agent];
	} else {
		const detected = detectIntegrations(projectRoot);
		if (detected.length > 0) {
			chosen = detected;
		} else if (tty) {
			chosen = await selectMany(
				"No AI tool detected. Select integrations to enable:",
				listIntegrations().map((i) => ({ label: `${i.key} — ${i.displayName}`, value: i.key })),
			);
			if (chosen.length === 0) {
				process.stderr.write("init aborted: no integrations selected\n");
				return 1;
			}
		} else {
			// Non-TTY fallback: claude (per requirements.md AC).
			chosen = ["claude"];
			process.stderr.write("[qult] no AI tool detected and non-TTY; falling back to claude\n");
		}
	}

	// 2. Confirm overwrite when integration files already exist (TTY only).
	if (!opts.force && tty && hasExistingConfig(projectRoot, chosen)) {
		const ok = await confirm(
			"Existing qult configuration detected. Overwrite generated sections?",
			false,
		);
		if (!ok) {
			process.stderr.write("init aborted: existing config preserved\n");
			return 1;
		}
	} else if (!opts.force && !tty && hasExistingConfig(projectRoot, chosen)) {
		process.stderr.write(
			"init aborted: existing config detected and not a TTY (re-run with --force)\n",
		);
		return 1;
	}

	// 3. Write AGENTS.md.
	const templateRoot = findTemplateRoot();
	await writeAgentsMd({ projectRoot, templateRoot, qultVersion: VERSION });

	// 4. Generate per-integration files.
	const ctx: GenerationContext = {
		projectRoot,
		templateRoot,
		vars: { QULT_VERSION: VERSION },
		force: opts.force ?? false,
		interactive: tty,
	};
	for (const key of chosen) {
		const integ = resolveIntegration(key);
		if (!integ) continue;
		await integ.generateConfigFiles(ctx);
		await integ.registerMcpServer(ctx);
	}

	// 5. Initialize .qult/ layout and persist integrations.enabled.
	mkdirSync(qultDir(), { recursive: true });
	mkdirSync(specsDir(), { recursive: true });
	updateEnabledIntegrations(chosen, "set");

	// 6. Report.
	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, integrations: chosen, version: VERSION })}\n`,
		);
	} else {
		process.stdout.write(`✔ qult initialized (v${VERSION})\n`);
		process.stdout.write(`  integrations: ${chosen.join(", ")}\n`);
		process.stdout.write("  next: edit .qult/specs/ or run 'qult check'\n");
	}
	return 0;
}

function hasExistingConfig(projectRoot: string, integrations: string[]): boolean {
	if (existsSync(join(projectRoot, "AGENTS.md"))) return true;
	for (const k of integrations) {
		if (k === "claude" && existsSync(join(projectRoot, ".mcp.json"))) return true;
		if (k === "cursor" && existsSync(join(projectRoot, ".cursor/mcp.json"))) return true;
		if (k === "gemini" && existsSync(join(projectRoot, ".gemini/settings.json"))) return true;
		if (k === "codex" && existsSync(join(projectRoot, ".codex/config.toml"))) return true;
	}
	return false;
}
