import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";

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
	meta: { description: "Set up qult hooks, skills, agents, and rules in ~/.claude/" },
	args: {
		force: { type: "boolean", description: "Overwrite existing configuration", default: false },
	},
	async run({ args }) {
		await runInit(args.force);
	},
});

/** Qult's hook definitions — the source of truth */
export const QULT_HOOKS: Record<
	string,
	Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>
> = {
	PostToolUse: [
		{
			matcher: "Edit",
			hooks: [{ type: "command", command: "qult hook post-tool", timeout: 5000 }],
		},
		{
			matcher: "Write",
			hooks: [{ type: "command", command: "qult hook post-tool", timeout: 5000 }],
		},
		{
			matcher: "Bash",
			hooks: [{ type: "command", command: "qult hook post-tool", timeout: 5000 }],
		},
	],
	PreToolUse: [
		{
			matcher: "Edit",
			hooks: [{ type: "command", command: "qult hook pre-tool", timeout: 3000 }],
		},
		{
			matcher: "Write",
			hooks: [{ type: "command", command: "qult hook pre-tool", timeout: 3000 }],
		},
		{
			matcher: "Bash",
			hooks: [{ type: "command", command: "qult hook pre-tool", timeout: 3000 }],
		},
	],
	UserPromptSubmit: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "qult hook user-prompt", timeout: 10000 }],
		},
	],
	SessionStart: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "qult hook session-start", timeout: 5000 }],
		},
	],
	Stop: [{ matcher: "", hooks: [{ type: "command", command: "qult hook stop", timeout: 5000 }] }],
	PreCompact: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "qult hook pre-compact", timeout: 10000 }],
		},
	],
	PostCompact: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "qult hook post-compact", timeout: 5000 }],
		},
	],
	PermissionRequest: [
		{
			matcher: "ExitPlanMode",
			hooks: [{ type: "command", command: "qult hook permission-request", timeout: 5000 }],
		},
	],
	SubagentStart: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "qult hook subagent-start", timeout: 3000 }],
		},
	],
	SubagentStop: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "qult hook subagent-stop", timeout: 5000 }],
		},
	],
	PostToolUseFailure: [
		{
			matcher: "Bash",
			hooks: [{ type: "command", command: "qult hook post-tool-failure", timeout: 3000 }],
		},
	],
	ConfigChange: [
		{
			matcher: "",
			hooks: [{ type: "command", command: "qult hook config-change", timeout: 3000 }],
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

	// Replace qult hooks, preserve non-qult hooks
	for (const event of Object.keys(QULT_HOOKS)) {
		const nonQult = (existingHooks[event] ?? []).filter((entry) => {
			const json = JSON.stringify(entry);
			return !json.includes("qult hook");
		});
		existingHooks[event] = [...nonQult, ...QULT_HOOKS[event]!];
		console.log(`  + ${event}`);
	}

	settings.hooks = existingHooks;
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

	// 2. Write skill, agent, rules
	console.log("Writing skill: /qult:review...");
	writeFile(
		join(claudeDir, "skills", "qult-review", "SKILL.md"),
		loadTemplate("skill-review.md"),
		force,
	);
	console.log("Writing agent: qult-reviewer...");
	writeFile(
		join(claudeDir, "agents", "qult-reviewer.md"),
		loadTemplate("agent-reviewer.md"),
		force,
	);
	console.log("Writing skill: /qult:detect-gates...");
	writeFile(
		join(claudeDir, "skills", "qult-detect-gates", "SKILL.md"),
		loadTemplate("skill-detect-gates.md"),
		force,
	);
	console.log("Writing rules: qult-quality...");
	writeFile(join(claudeDir, "rules", "qult-quality.md"), loadTemplate("rules-quality.md"), force);

	// 3. Create .qult/ and gates.json
	const qultDir = join(process.cwd(), ".qult");
	mkdirSync(join(qultDir, ".state"), { recursive: true });

	const gatesPath = join(qultDir, "gates.json");
	if (!existsSync(gatesPath) || force) {
		writeFileSync(gatesPath, "{}");
		console.log(`  Created ${gatesPath} (run /qult:detect-gates to configure)`);
	}

	// 4. Clear stale pending-fixes (fresh start)
	const pendingPath = join(qultDir, ".state", "pending-fixes.json");
	writeFileSync(pendingPath, "[]");

	// 5. Register project in central registry (~/.qult/registry.json)
	registerProject(home, process.cwd());

	// 6. Add .qult/ to .gitignore if not already present
	const gitignorePath = join(process.cwd(), ".gitignore");
	try {
		const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
		if (!gitignore.includes(".qult/") && !gitignore.includes(".qult\n")) {
			const newline = gitignore.length > 0 && !gitignore.endsWith("\n") ? "\n" : "";
			writeFileSync(gitignorePath, `${gitignore}${newline}.qult/\n`);
			console.log("  + .qult/ added to .gitignore");
		}
	} catch {
		// fail-open
	}

	console.log("\nqult init complete.");
}

interface RegistryEntry {
	path: string;
	registered_at: string;
}

function registerProject(home: string, projectPath: string): void {
	try {
		const registryDir = join(home, ".qult");
		mkdirSync(registryDir, { recursive: true });
		const registryPath = join(registryDir, "registry.json");

		let entries: RegistryEntry[] = [];
		if (existsSync(registryPath)) {
			entries = JSON.parse(readFileSync(registryPath, "utf-8"));
		}

		// Update existing or add new entry
		const existing = entries.findIndex((e) => e.path === projectPath);
		const entry: RegistryEntry = { path: projectPath, registered_at: new Date().toISOString() };
		if (existing >= 0) {
			entries[existing] = entry;
		} else {
			entries.push(entry);
		}

		writeFileSync(registryPath, JSON.stringify(entries, null, 2));
		console.log(`  + registered in ~/.qult/registry.json`);
	} catch {
		// fail-open
	}
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
