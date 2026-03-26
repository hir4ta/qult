import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { detectGates } from "./gates/detect.ts";

export const initCommand = defineCommand({
	meta: { description: "Set up alfred hooks, skills, agents, and rules in ~/.claude/" },
	args: {
		force: { type: "boolean", description: "Overwrite existing configuration", default: false },
	},
	async run({ args }) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		const claudeDir = join(home, ".claude");
		const settingsPath = join(claudeDir, "settings.json");

		// 1. Write hooks to ~/.claude/settings.json
		console.log("Writing hooks to settings.json...");
		writeHooks(settingsPath, args.force);

		// 2. Create .alfred/ and gates.json
		const alfredDir = join(process.cwd(), ".alfred");
		const stateDir = join(alfredDir, ".state");
		mkdirSync(stateDir, { recursive: true });

		const gatesPath = join(alfredDir, "gates.json");
		if (!existsSync(gatesPath) || args.force) {
			console.log("Detecting gates...");
			const gates = detectGates(process.cwd());
			writeFileSync(gatesPath, JSON.stringify(gates, null, 2));
			console.log(`  Created ${gatesPath}`);
		}

		console.log("\nalfred init complete.");
		console.log("Run 'alfred doctor' to verify.");
	},
});

const HOOK_EVENTS = {
	PostToolUse: { timeout: 5000 },
	PreToolUse: { timeout: 3000 },
	UserPromptSubmit: { timeout: 10000 },
	SessionStart: { timeout: 5000 },
	Stop: { timeout: 5000 },
	PreCompact: { timeout: 10000 },
} as const;

function writeHooks(settingsPath: string, force: boolean): void {
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			// start fresh
		}
	}

	const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

	for (const [event, config] of Object.entries(HOOK_EVENTS)) {
		const existing = hooks[event] as Array<{ command?: string }> | undefined;
		const hasAlfred = existing?.some((h) => h.command?.includes("alfred hook"));

		if (!hasAlfred || force) {
			const hookEntry = {
				type: "command",
				command: `alfred hook ${eventToArg(event)}`,
				timeout: config.timeout,
			};

			if (hasAlfred && force) {
				hooks[event] = existing!.filter((h) => !h.command?.includes("alfred hook"));
			}
			hooks[event] = [...(hooks[event] ?? []), hookEntry];
			console.log(`  + ${event} hook`);
		} else {
			console.log(`  = ${event} hook (already exists)`);
		}
	}

	settings.hooks = hooks;

	const dir = join(settingsPath, "..");
	mkdirSync(dir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function eventToArg(event: string): string {
	// PostToolUse → post-tool, PreToolUse → pre-tool, etc.
	return event
		.replace(/([A-Z])/g, "-$1")
		.toLowerCase()
		.replace(/^-/, "");
}
