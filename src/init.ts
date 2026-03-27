import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { detectGates } from "./gates/detect.ts";

function loadTemplate(name: string): string {
	const candidates = [
		join(import.meta.dirname, "templates", name),
		join(import.meta.dirname, "..", "src", "templates", name),
	];
	for (const path of candidates) {
		if (existsSync(path)) return readFileSync(path, "utf-8");
	}
	throw new Error(`Template not found: ${name}`);
}

export const initCommand = defineCommand({
	meta: { description: "Set up alfred hooks, skills, agents, and rules in ~/.claude/" },
	args: {
		force: { type: "boolean", description: "Overwrite existing configuration", default: false },
	},
	async run({ args }) {
		await runInit(args.force);
	},
});

/** Alfred's hook definitions — the source of truth */
export const ALFRED_HOOKS: Record<
	string,
	Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>
> = {
	PostToolUse: [
		{
			matcher: "Edit",
			hooks: [{ type: "command", command: "alfred hook post-tool", timeout: 5000 }],
		},
		{
			matcher: "Write",
			hooks: [{ type: "command", command: "alfred hook post-tool", timeout: 5000 }],
		},
		{
			matcher: "Bash",
			hooks: [{ type: "command", command: "alfred hook post-tool", timeout: 5000 }],
		},
	],
	PreToolUse: [
		{
			matcher: "Edit",
			hooks: [{ type: "command", command: "alfred hook pre-tool", timeout: 3000 }],
		},
		{
			matcher: "Write",
			hooks: [{ type: "command", command: "alfred hook pre-tool", timeout: 3000 }],
		},
		{
			matcher: "Bash",
			hooks: [{ type: "command", command: "alfred hook pre-tool", timeout: 3000 }],
		},
	],
	UserPromptSubmit: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "alfred hook user-prompt", timeout: 10000 }],
		},
	],
	SessionStart: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "alfred hook session-start", timeout: 5000 }],
		},
	],
	Stop: [{ matcher: "", hooks: [{ type: "command", command: "alfred hook stop", timeout: 5000 }] }],
	PreCompact: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "alfred hook pre-compact", timeout: 10000 }],
		},
	],
	PostCompact: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "alfred hook post-compact", timeout: 5000 }],
		},
	],
	PermissionRequest: [
		{
			matcher: "ExitPlanMode",
			hooks: [{ type: "command", command: "alfred hook permission-request", timeout: 5000 }],
		},
	],
	SubagentStart: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "alfred hook subagent-start", timeout: 3000 }],
		},
	],
	SubagentStop: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "alfred hook subagent-stop", timeout: 5000 }],
		},
	],
	PostToolUseFailure: [
		{
			matcher: "Bash",
			hooks: [{ type: "command", command: "alfred hook post-tool-failure", timeout: 3000 }],
		},
	],
	ConfigChange: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "alfred hook config-change", timeout: 3000 }],
		},
	],
};

export async function runInit(force: boolean): Promise<void> {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const claudeDir = join(home, ".claude");
	const settingsPath = join(claudeDir, "settings.json");

	// 1. Merge hooks into settings.json
	console.log("Writing hooks to settings.json...");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			console.error("  Warning: could not parse existing settings.json, starting fresh");
		}
	}

	const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

	// Replace alfred hooks, preserve non-alfred hooks
	for (const event of Object.keys(ALFRED_HOOKS)) {
		const nonAlfred = (existingHooks[event] ?? []).filter((entry) => {
			const json = JSON.stringify(entry);
			return !json.includes("alfred hook");
		});
		existingHooks[event] = [...nonAlfred, ...ALFRED_HOOKS[event]!];
		console.log(`  + ${event}`);
	}

	settings.hooks = existingHooks;
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

	// 2. Write skill, agent, rules
	console.log("Writing skill: /alfred:review...");
	writeFile(
		join(claudeDir, "skills", "alfred-review", "SKILL.md"),
		loadTemplate("skill-review.md"),
		force,
	);
	console.log("Writing agent: alfred-reviewer...");
	writeFile(
		join(claudeDir, "agents", "alfred-reviewer.md"),
		loadTemplate("agent-reviewer.md"),
		force,
	);
	console.log("Writing rules: alfred-quality...");
	writeFile(join(claudeDir, "rules", "alfred-quality.md"), loadTemplate("rules-quality.md"), force);

	// 3. Create .alfred/ and gates.json
	const alfredDir = join(process.cwd(), ".alfred");
	mkdirSync(join(alfredDir, ".state"), { recursive: true });

	const gatesPath = join(alfredDir, "gates.json");
	if (!existsSync(gatesPath) || force) {
		console.log("Detecting gates...");
		const gates = detectGates(process.cwd());
		writeFileSync(gatesPath, JSON.stringify(gates, null, 2));
		console.log(`  Created ${gatesPath}`);
	}

	// 4. Clear stale pending-fixes (fresh start)
	const pendingPath = join(alfredDir, ".state", "pending-fixes.json");
	writeFileSync(pendingPath, "[]");

	// 5. Add .alfred/ to .gitignore if not already present
	const gitignorePath = join(process.cwd(), ".gitignore");
	try {
		const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
		if (!gitignore.includes(".alfred/") && !gitignore.includes(".alfred\n")) {
			const newline = gitignore.length > 0 && !gitignore.endsWith("\n") ? "\n" : "";
			writeFileSync(gitignorePath, `${gitignore}${newline}.alfred/\n`);
			console.log("  + .alfred/ added to .gitignore");
		}
	} catch {
		// fail-open
	}

	console.log("\nalfred init complete.");
}

function writeFile(path: string, content: string, force: boolean): void {
	if (existsSync(path) && !force) {
		console.log(`  = ${path} (exists)`);
		return;
	}
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	console.log(`  + ${path}`);
}
