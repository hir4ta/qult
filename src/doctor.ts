import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { ALFRED_HOOKS } from "./init.ts";
import type { GatesConfig } from "./types.ts";

export type CheckStatus = "ok" | "fail" | "warn";
export interface CheckResult {
	name: string;
	status: CheckStatus;
	message: string;
}

function getBunVersion(): string | null {
	if (process.versions.bun) return process.versions.bun;
	try {
		const { execSync } = require("node:child_process");
		return execSync("bun --version", { encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}

function checkBun(): CheckResult {
	const version = getBunVersion();
	if (!version) return { name: "bun", status: "fail", message: "Bun not detected" };
	const [major, minor] = version.split(".").map(Number);
	if (major! > 1 || (major === 1 && minor! >= 3)) {
		return { name: "bun", status: "ok", message: `Bun ${version}` };
	}
	return { name: "bun", status: "fail", message: `Bun ${version} (requires >= 1.3)` };
}

function checkHooks(): CheckResult {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const settingsPath = join(home, ".claude", "settings.json");
	if (!existsSync(settingsPath)) {
		return { name: "hooks", status: "fail", message: "settings.json not found" };
	}
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = settings.hooks ?? {};
		const expected = Object.keys(ALFRED_HOOKS);
		const registered = expected.filter((event) => {
			const entries = hooks[event];
			if (!Array.isArray(entries)) return false;
			return entries.some((e: Record<string, unknown>) =>
				JSON.stringify(e).includes("alfred hook"),
			);
		});
		if (registered.length === expected.length) {
			return {
				name: "hooks",
				status: "ok",
				message: `${registered.length}/${expected.length} hooks registered`,
			};
		}
		const missing = expected.filter((e) => !registered.includes(e));
		return {
			name: "hooks",
			status: "fail",
			message: `${registered.length}/${expected.length} hooks registered (missing: ${missing.join(", ")})`,
		};
	} catch {
		return { name: "hooks", status: "fail", message: "Failed to parse settings.json" };
	}
}

function checkFileExists(name: string, path: string, label: string): CheckResult {
	if (existsSync(path)) {
		return { name, status: "ok", message: `${label} installed` };
	}
	return { name, status: "fail", message: `${label} not found (${path})` };
}

function checkGates(): CheckResult {
	const gatesPath = join(process.cwd(), ".alfred", "gates.json");
	if (!existsSync(gatesPath)) {
		return { name: "gates", status: "fail", message: "gates.json not found" };
	}
	try {
		const gates: GatesConfig = JSON.parse(readFileSync(gatesPath, "utf-8"));
		const onWriteCount = Object.keys(gates.on_write ?? {}).length;
		const onCommitCount = Object.keys(gates.on_commit ?? {}).length;
		if (onWriteCount === 0) {
			return { name: "gates", status: "fail", message: "gates.json has no on_write gates" };
		}
		return {
			name: "gates",
			status: "ok",
			message: `gates.json: ${onWriteCount} on_write, ${onCommitCount} on_commit`,
		};
	} catch {
		return { name: "gates", status: "fail", message: "Failed to parse gates.json" };
	}
}

function checkStateDir(): CheckResult {
	const stateDir = join(process.cwd(), ".alfred", ".state");
	if (existsSync(stateDir)) {
		return { name: "state", status: "ok", message: ".alfred/.state/ exists" };
	}
	return { name: "state", status: "fail", message: ".alfred/.state/ not found (run alfred init)" };
}

function checkPath(): CheckResult {
	try {
		const { execSync } = require("node:child_process");
		const path = execSync("which alfred", { encoding: "utf-8" }).trim();
		return { name: "path", status: "ok", message: `alfred in PATH (${path})` };
	} catch {
		return { name: "path", status: "warn", message: "alfred not in PATH" };
	}
}

/** Run all health checks and return results */
export function runChecks(): CheckResult[] {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const claudeDir = join(home, ".claude");
	return [
		checkBun(),
		checkHooks(),
		checkFileExists(
			"skill",
			join(claudeDir, "skills", "alfred-review", "SKILL.md"),
			"/alfred:review skill",
		),
		checkFileExists(
			"agent",
			join(claudeDir, "agents", "alfred-reviewer.md"),
			"alfred-reviewer agent",
		),
		checkFileExists("rules", join(claudeDir, "rules", "alfred-quality.md"), "alfred-quality rules"),
		checkGates(),
		checkStateDir(),
		checkPath(),
	];
}

export const doctorCommand = defineCommand({
	meta: { description: "Check alfred health" },
	async run() {
		const results = runChecks();
		for (const r of results) {
			const tag = r.status === "ok" ? "[OK]" : r.status === "fail" ? "[FAIL]" : "[WARN]";
			console.log(`${tag} ${r.message}`);
		}
		const hasFail = results.some((r) => r.status === "fail");
		if (hasFail) process.exit(1);
	},
});
