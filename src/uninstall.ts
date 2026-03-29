import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";

interface UninstallTarget {
	path: string;
	description: string;
	type: "file" | "dir" | "hook-cleanup";
}

/** Collect all files/dirs that qult installed */
function collectTargets(): UninstallTarget[] {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const claudeDir = join(home, ".claude");
	const targets: UninstallTarget[] = [];

	// 1. Hooks in settings.json (special: modify, don't delete)
	const settingsPath = join(claudeDir, "settings.json");
	if (existsSync(settingsPath)) {
		targets.push({
			path: settingsPath,
			description: "Remove qult hooks from settings.json",
			type: "hook-cleanup",
		});
	}

	// 2. Skills
	const skills = ["qult-review", "qult-detect-gates", "qult-plan-generator"];
	for (const skill of skills) {
		const dir = join(claudeDir, "skills", skill);
		if (existsSync(dir)) {
			targets.push({ path: dir, description: `Skill: ${skill}`, type: "dir" });
		}
	}

	// 3. Agents
	const agents = ["qult-reviewer.md", "qult-plan-generator.md", "qult-plan-evaluator.md"];
	for (const agent of agents) {
		const path = join(claudeDir, "agents", agent);
		if (existsSync(path)) {
			targets.push({ path, description: `Agent: ${agent}`, type: "file" });
		}
	}

	// 4. Rules
	const rules = ["qult-quality.md", "qult-plan.md"];
	for (const rule of rules) {
		const path = join(claudeDir, "rules", rule);
		if (existsSync(path)) {
			targets.push({ path, description: `Rule: ${rule}`, type: "file" });
		}
	}

	// 5. .qult/.state/ in current project
	const stateDir = join(process.cwd(), ".qult", ".state");
	if (existsSync(stateDir)) {
		targets.push({ path: stateDir, description: ".qult/.state/ (session state)", type: "dir" });
	}

	// 6. Registry entry
	const registryPath = join(home, ".qult", "registry.json");
	if (existsSync(registryPath)) {
		targets.push({
			path: registryPath,
			description: "Remove project from ~/.qult/registry.json",
			type: "file",
		});
	}

	return targets;
}

/** Remove qult hooks from settings.json, preserve non-qult hooks */
function removeHooksFromSettings(): void {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const settingsPath = join(home, ".claude", "settings.json");
	if (!existsSync(settingsPath)) return;

	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = settings.hooks ?? {};

		for (const event of Object.keys(hooks)) {
			if (!Array.isArray(hooks[event])) continue;
			hooks[event] = hooks[event].filter((entry: unknown) => {
				const json = JSON.stringify(entry);
				return !json.includes("qult hook");
			});
			if (hooks[event].length === 0) {
				delete hooks[event];
			}
		}

		if (Object.keys(hooks).length === 0) {
			delete settings.hooks;
		} else {
			settings.hooks = hooks;
		}

		writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	} catch {
		// fail-open
	}
}

/** Remove project from registry.json */
function removeFromRegistry(): void {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const registryPath = join(home, ".qult", "registry.json");
	if (!existsSync(registryPath)) return;

	try {
		const entries = JSON.parse(readFileSync(registryPath, "utf-8"));
		if (!Array.isArray(entries)) return;
		const filtered = entries.filter((e: { path: string }) => e.path !== process.cwd());
		writeFileSync(registryPath, JSON.stringify(filtered, null, 2));
	} catch {
		// fail-open
	}
}

export async function runUninstall(yes: boolean): Promise<void> {
	const targets = collectTargets();

	if (targets.length === 0) {
		console.log("Nothing to uninstall.");
		return;
	}

	console.log("The following will be removed:\n");
	for (const t of targets) {
		console.log(`  - ${t.description}`);
		if (t.type !== "hook-cleanup") {
			console.log(`    ${t.path}`);
		}
	}

	if (!yes) {
		console.log("\nRun with --yes to confirm removal.");
		return;
	}

	console.log("\nUninstalling...");

	for (const t of targets) {
		try {
			if (t.type === "hook-cleanup") {
				removeHooksFromSettings();
				console.log(`  [OK] ${t.description}`);
			} else if (t.type === "dir") {
				rmSync(t.path, { recursive: true });
				console.log(`  [OK] ${t.description}`);
			} else if (t.type === "file") {
				if (t.path.endsWith("registry.json")) {
					removeFromRegistry();
				} else {
					unlinkSync(t.path);
				}
				console.log(`  [OK] ${t.description}`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`  [FAIL] ${t.description}: ${msg}`);
		}
	}

	console.log("\nqult uninstalled from this project.");
	console.log("To remove the binary: rm $(which qult)");
}

export const uninstallCommand = defineCommand({
	meta: { description: "Remove qult hooks, skills, agents, and rules" },
	args: {
		yes: {
			type: "boolean",
			description: "Skip confirmation and remove immediately",
			default: false,
		},
	},
	async run({ args }) {
		await runUninstall(args.yes);
	},
});
