import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { detectGates } from "./gates/detect.ts";

function loadTemplate(name: string): string {
	// In dev: read from src/templates/. In built binary: read from same relative path.
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

export async function runInit(force: boolean): Promise<void> {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const claudeDir = join(home, ".claude");

	// 1. Write hooks to settings.json
	console.log("Writing hooks to settings.json...");
	const settingsPath = join(claudeDir, "settings.json");
	writeHooks(settingsPath, force);

	// 2. Write skill
	console.log("Writing skill: /alfred:review...");
	const skillDir = join(claudeDir, "skills", "alfred-review");
	writeTemplateFile(join(skillDir, "SKILL.md"), loadTemplate("skill-review.md"), force);

	// 3. Write agent
	console.log("Writing agent: alfred-reviewer...");
	const agentDir = join(claudeDir, "agents");
	writeTemplateFile(join(agentDir, "alfred-reviewer.md"), loadTemplate("agent-reviewer.md"), force);

	// 4. Write rules
	console.log("Writing rules: alfred-quality...");
	const rulesDir = join(claudeDir, "rules");
	writeTemplateFile(join(rulesDir, "alfred-quality.md"), loadTemplate("rules-quality.md"), force);

	// 5. Create .alfred/ and gates.json
	const alfredDir = join(process.cwd(), ".alfred");
	const stateDir = join(alfredDir, ".state");
	mkdirSync(stateDir, { recursive: true });

	const gatesPath = join(alfredDir, "gates.json");
	if (!existsSync(gatesPath) || force) {
		console.log("Detecting gates...");
		const gates = detectGates(process.cwd());
		writeFileSync(gatesPath, JSON.stringify(gates, null, 2));
		console.log(`  Created ${gatesPath}`);
	}

	console.log("\nalfred init complete.");
	console.log("Run 'alfred doctor' to verify.");
}

function writeTemplateFile(path: string, content: string, force: boolean): void {
	if (existsSync(path) && !force) {
		console.log(`  = ${path} (already exists)`);
		return;
	}
	const dir = join(path, "..");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, content);
	console.log(`  + ${path}`);
}

const HOOK_EVENTS = {
	PostToolUse: { timeout: 5000 },
	PreToolUse: { timeout: 3000 },
	UserPromptSubmit: { timeout: 10000 },
	SessionStart: { timeout: 5000 },
	Stop: { timeout: 5000 },
	PreCompact: { timeout: 10000 },
	PermissionRequest: { timeout: 5000, matcher: "ExitPlanMode" },
	TaskCompleted: { timeout: 5000 },
	SubagentStart: { timeout: 3000 },
	SubagentStop: { timeout: 5000 },
	PostToolUseFailure: { timeout: 3000 },
	SessionEnd: { timeout: 3000 },
	ConfigChange: { timeout: 3000 },
} as const;

/**
 * Claude Code hook format (v2.1+):
 * {
 *   "hooks": {
 *     "PostToolUse": [
 *       { "matcher": "Edit|Write", "hooks": [{"type": "command", "command": "...", "timeout": 5000}] }
 *     ]
 *   }
 * }
 * Each event is an array of matcher groups. Each group has `matcher` (string) and `hooks` (array).
 */
function writeHooks(settingsPath: string, force: boolean): void {
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			console.error("  Warning: could not parse existing settings.json, starting fresh");
		}
	}

	const hooks = (settings.hooks ?? {}) as Record<string, MatcherGroup[]>;

	for (const [event, config] of Object.entries(HOOK_EVENTS)) {
		const existing = hooks[event] ?? [];
		const hasAlfred = existing.some((entry) => {
			// New nested format
			if (entry.hooks) {
				return entry.hooks.some((h) => h.command?.includes("alfred hook"));
			}
			// Old flat format
			const cmd = (entry as Record<string, unknown>).command;
			return typeof cmd === "string" && cmd.includes("alfred hook");
		});

		if (!hasAlfred || force) {
			const hookDef: Record<string, unknown> = {
				type: "command",
				command: `alfred hook ${eventToArg(event)}`,
				timeout: config.timeout,
			};

			const matcher = "matcher" in config ? (config.matcher as string) : "";

			if (force) {
				// Remove ALL alfred-related entries (both old flat format and new nested format)
				hooks[event] = existing.filter((entry) => {
					// Old flat format: { type, command, timeout } at top level
					const isOldFlat =
						"command" in entry && typeof (entry as Record<string, unknown>).command === "string";
					if (isOldFlat) {
						return !(entry as Record<string, unknown> & { command: string }).command.includes(
							"alfred hook",
						);
					}
					// New nested format: { matcher, hooks: [...] }
					if (entry.hooks) {
						entry.hooks = entry.hooks.filter((h) => !h.command?.includes("alfred hook"));
						return entry.hooks.length > 0;
					}
					return true;
				});
			}

			hooks[event] = [...(hooks[event] ?? []), { matcher, hooks: [hookDef] }];
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

interface MatcherGroup {
	matcher?: string;
	hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

const EVENT_TO_ARG: Record<string, string> = {
	PostToolUse: "post-tool",
	PreToolUse: "pre-tool",
	UserPromptSubmit: "user-prompt",
	SessionStart: "session-start",
	Stop: "stop",
	PreCompact: "pre-compact",
	PermissionRequest: "permission-request",
	TaskCompleted: "task-completed",
	SubagentStart: "subagent-start",
	SubagentStop: "subagent-stop",
	PostToolUseFailure: "post-tool-failure",
	SessionEnd: "session-end",
	ConfigChange: "config-change",
};

function eventToArg(event: string): string {
	return EVENT_TO_ARG[event] ?? event.toLowerCase();
}
