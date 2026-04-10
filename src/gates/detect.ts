import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateDefinition, GatesConfig } from "../types.ts";

/** Package manager detected from lockfile */
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm" | null;

/** Detection result for a single gate */
interface DetectedGate {
	name: string;
	category: "on_write" | "on_commit" | "on_review";
	gate: GateDefinition;
}

// --- Lockfile → package manager ---

const LOCKFILE_PM: [string, PackageManager][] = [
	["bun.lockb", "bun"],
	["bun.lock", "bun"],
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["package-lock.json", "npm"],
];

export function detectPackageManager(root: string): PackageManager {
	for (const [lockfile, pm] of LOCKFILE_PM) {
		if (existsSync(join(root, lockfile))) return pm;
	}
	return null;
}

// --- Config file → gate mapping ---
// Priority: first match wins per category

interface ProbeRule {
	configs: string[];
	name: string;
	category: "on_write" | "on_commit" | "on_review";
	command: string | ((pm: PackageManager) => string);
	timeout?: number;
	run_once_per_batch?: boolean;
	/** If set, only probe if this executable is reachable */
	executable?: string;
}

const PROBE_RULES: ProbeRule[] = [
	// --- on_write: lint (priority order) ---
	{
		configs: ["biome.json", "biome.jsonc"],
		name: "lint",
		category: "on_write",
		command: "biome check {file}",
		timeout: 3000,
		executable: "biome",
	},
	{
		configs: [
			"eslint.config.js",
			"eslint.config.mjs",
			"eslint.config.cjs",
			"eslint.config.ts",
			".eslintrc.json",
			".eslintrc.js",
			".eslintrc.yml",
			".eslintrc.yaml",
			".eslintrc",
		],
		name: "lint",
		category: "on_write",
		command: "eslint {file}",
		timeout: 5000,
		executable: "eslint",
	},
	{
		configs: ["deno.json", "deno.jsonc"],
		name: "lint",
		category: "on_write",
		command: "deno lint {file}",
		timeout: 3000,
		executable: "deno",
	},
	{
		configs: ["ruff.toml"],
		name: "lint",
		category: "on_write",
		command: "ruff check {file}",
		timeout: 3000,
		executable: "ruff",
	},
	{
		configs: [".rubocop.yml"],
		name: "lint",
		category: "on_write",
		command: "rubocop {file}",
		timeout: 5000,
		executable: "rubocop",
	},
	{
		configs: [".golangci.yml", ".golangci.yaml"],
		name: "lint",
		category: "on_write",
		command: "golangci-lint run {file}",
		timeout: 5000,
		executable: "golangci-lint",
	},

	// --- on_write: security (priority order) ---
	{
		configs: [".semgrep.yml", ".semgrep/rules.yml"],
		name: "security-semgrep-write",
		category: "on_write",
		command: "semgrep scan --config auto --quiet {file}",
		timeout: 5000,
		executable: "semgrep",
	},

	// --- on_write: typecheck (priority order) ---
	{
		configs: ["tsconfig.json"],
		name: "typecheck",
		category: "on_write",
		command: (pm) => (pm === "bun" ? "bun tsc --noEmit" : "tsc --noEmit"),
		timeout: 10000,
		run_once_per_batch: true,
		executable: "tsc",
	},
	{
		configs: ["pyrightconfig.json"],
		name: "typecheck",
		category: "on_write",
		command: "pyright",
		timeout: 15000,
		run_once_per_batch: true,
		executable: "pyright",
	},
	{
		configs: ["mypy.ini"],
		name: "typecheck",
		category: "on_write",
		command: "mypy .",
		timeout: 15000,
		run_once_per_batch: true,
		executable: "mypy",
	},
	{
		configs: ["go.mod"],
		name: "typecheck",
		category: "on_write",
		command: "go vet ./...",
		timeout: 10000,
		run_once_per_batch: true,
		executable: "go",
	},
	{
		configs: ["Cargo.toml"],
		name: "typecheck",
		category: "on_write",
		command: "cargo check",
		timeout: 30000,
		run_once_per_batch: true,
		executable: "cargo",
	},

	// --- on_commit: test (priority order) ---
	{
		configs: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs"],
		name: "test",
		category: "on_commit",
		command: (pm) => (pm === "bun" ? "bun vitest run" : "vitest run"),
		timeout: 30000,
		executable: "vitest",
	},
	{
		configs: ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"],
		name: "test",
		category: "on_commit",
		command: "jest",
		timeout: 30000,
		executable: "jest",
	},
	{
		configs: ["pytest.ini", "setup.cfg", "conftest.py"],
		name: "test",
		category: "on_commit",
		command: "pytest",
		timeout: 60000,
		executable: "pytest",
	},
	{
		configs: ["go.mod"],
		name: "test",
		category: "on_commit",
		command: "go test ./...",
		timeout: 60000,
		executable: "go",
	},
	{
		configs: ["Cargo.toml"],
		name: "test",
		category: "on_commit",
		command: "cargo test",
		timeout: 60000,
		executable: "cargo",
	},
	{
		configs: [".rspec"],
		name: "test",
		category: "on_commit",
		command: "rspec",
		timeout: 60000,
		executable: "rspec",
	},
	{
		configs: ["mix.exs"],
		name: "test",
		category: "on_commit",
		command: "mix test",
		timeout: 60000,
		executable: "mix",
	},
	{
		configs: ["deno.json", "deno.jsonc"],
		name: "test",
		category: "on_commit",
		command: "deno test",
		timeout: 30000,
		executable: "deno",
	},

	// --- on_commit: security (priority order) ---
	{
		configs: [".semgrep.yml", ".semgrep/rules.yml"],
		name: "security-semgrep",
		category: "on_commit",
		command: "semgrep scan --config auto --quiet",
		timeout: 30000,
		run_once_per_batch: true,
		executable: "semgrep",
	},
	{
		configs: ["bandit.yml", ".bandit"],
		name: "security-bandit",
		category: "on_commit",
		command: "bandit -r . -q",
		timeout: 30000,
		run_once_per_batch: true,
		executable: "bandit",
	},
	{
		configs: ["go.mod"],
		name: "security-gosec",
		category: "on_commit",
		command: "gosec -quiet ./...",
		timeout: 30000,
		run_once_per_batch: true,
		executable: "gosec",
	},
	{
		configs: [".gitleaks.toml"],
		name: "security-gitleaks",
		category: "on_commit",
		command: "gitleaks detect --no-git --source . -q",
		timeout: 30000,
		run_once_per_batch: true,
		executable: "gitleaks",
	},

	// --- on_commit: dependency audit (priority order) ---
	{
		configs: ["package-lock.json", "package.json"],
		name: "audit-npm",
		category: "on_commit",
		command: "npm audit --audit-level=high",
		timeout: 30000,
		run_once_per_batch: true,
		executable: "npm",
	},
	{
		configs: ["requirements.txt", "pyproject.toml"],
		name: "audit-pip",
		category: "on_commit",
		command: "pip-audit",
		timeout: 30000,
		run_once_per_batch: true,
		executable: "pip-audit",
	},
	{
		configs: ["Cargo.toml"],
		name: "audit-cargo",
		category: "on_commit",
		command: "cargo audit",
		timeout: 30000,
		run_once_per_batch: true,
		executable: "cargo-audit",
	},

	// --- on_review: e2e (priority order) ---
	{
		configs: [
			"playwright.config.ts",
			"playwright.config.js",
			"playwright.config.mts",
			"playwright.config.mjs",
		],
		name: "e2e",
		category: "on_review",
		command: "playwright test",
		timeout: 120000,
		executable: "playwright",
	},
	{
		configs: ["cypress.config.ts", "cypress.config.js", "cypress.config.mjs", "cypress.config.cjs"],
		name: "e2e",
		category: "on_review",
		command: "cypress run",
		timeout: 120000,
		executable: "cypress",
	},
	{
		configs: ["wdio.conf.ts", "wdio.conf.js"],
		name: "e2e",
		category: "on_review",
		command: "wdio run",
		timeout: 120000,
		executable: "wdio",
	},
];

/** Check if an executable is reachable via PATH or node_modules/.bin */
export function isReachable(exe: string, root: string): boolean {
	// Validate exe to prevent command injection (only alphanumeric, dash, underscore)
	if (!/^[a-zA-Z0-9_-]+$/.test(exe)) return false;
	const nodeModulesBin = join(root, "node_modules", ".bin", exe);
	if (existsSync(nodeModulesBin)) return true;
	try {
		const { execFileSync } = require("node:child_process");
		execFileSync("/bin/sh", ["-c", `command -v ${exe}`], {
			encoding: "utf-8",
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

/** Check pyproject.toml for tool-specific sections */
function hasPyprojectSection(root: string, tool: string): boolean {
	try {
		const content = readFileSync(join(root, "pyproject.toml"), "utf-8");
		return content.includes(`[tool.${tool}]`);
	} catch {
		return false;
	}
}

/** Check package.json for devDependency or script */
function checkPackageJson(
	root: string,
): { devDeps: Set<string>; scripts: Record<string, string> } | null {
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
		return {
			devDeps: new Set([
				...Object.keys(pkg.devDependencies ?? {}),
				...Object.keys(pkg.dependencies ?? {}),
			]),
			scripts: pkg.scripts ?? {},
		};
	} catch {
		return null;
	}
}

/** Detect gates from project structure. Pure function (no side effects). */
export function detectGates(root: string): GatesConfig {
	const pm = detectPackageManager(root);
	const pkg = checkPackageJson(root);
	const found = new Set<string>(); // "category:name" → first match wins

	const gates: DetectedGate[] = [];

	for (const rule of PROBE_RULES) {
		const key = `${rule.category}:${rule.name}`;
		if (found.has(key)) continue;

		// Check config files
		let configFound = false;
		for (const cfg of rule.configs) {
			if (existsSync(join(root, cfg))) {
				configFound = true;
				break;
			}
		}

		// Fallback: check pyproject.toml sections for Python tools
		if (!configFound && rule.executable === "ruff") {
			configFound = hasPyprojectSection(root, "ruff");
		}
		if (!configFound && rule.executable === "pyright") {
			configFound = hasPyprojectSection(root, "pyright");
		}
		if (!configFound && rule.executable === "mypy") {
			configFound = hasPyprojectSection(root, "mypy");
		}
		if (!configFound && rule.executable === "pytest") {
			configFound = hasPyprojectSection(root, "pytest");
		}
		if (!configFound && rule.executable === "bandit") {
			configFound = hasPyprojectSection(root, "bandit");
		}

		// Fallback: check package.json devDependencies for JS tools
		if (
			!configFound &&
			pkg &&
			rule.executable &&
			["vitest", "jest", "mocha", "eslint", "biome"].includes(rule.executable)
		) {
			if (pkg.devDeps.has(rule.executable) || pkg.devDeps.has(`@biomejs/${rule.executable}`)) {
				configFound = true;
			}
		}

		// Fallback: check package.json "jest" field
		if (!configFound && rule.executable === "jest" && pkg) {
			try {
				const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
				if (raw.jest) configFound = true;
			} catch {
				/* ignore */
			}
		}

		if (!configFound) continue;

		// Verify executable is reachable
		if (rule.executable && !isReachable(rule.executable, root)) continue;

		const command = typeof rule.command === "function" ? rule.command(pm) : rule.command;
		const gate: GateDefinition = { command };
		if (rule.timeout) gate.timeout = rule.timeout;
		if (rule.run_once_per_batch) gate.run_once_per_batch = true;

		gates.push({ name: rule.name, category: rule.category, gate });
		found.add(key);
	}

	// Fallback: package.json scripts
	if (pkg) {
		if (!found.has("on_write:lint")) {
			const lintScript = pkg.scripts.lint ?? pkg.scripts["lint:check"];
			if (lintScript) {
				const runner = pm ?? "npm";
				gates.push({
					name: "lint",
					category: "on_write",
					gate: { command: `${runner} run lint`, timeout: 5000, run_once_per_batch: true },
				});
				found.add("on_write:lint");
			}
		}
		if (!found.has("on_write:typecheck")) {
			const tcScript = pkg.scripts.typecheck ?? pkg.scripts["type-check"];
			if (tcScript) {
				const runner = pm ?? "npm";
				gates.push({
					name: "typecheck",
					category: "on_write",
					gate: {
						command: `${runner} run typecheck`,
						timeout: 10000,
						run_once_per_batch: true,
					},
				});
				found.add("on_write:typecheck");
			}
		}
		if (!found.has("on_commit:test")) {
			const testScript = pkg.scripts.test ?? pkg.scripts["test:unit"];
			if (testScript) {
				const runner = pm ?? "npm";
				gates.push({
					name: "test",
					category: "on_commit",
					gate: { command: `${runner} run test`, timeout: 30000 },
				});
				found.add("on_commit:test");
			}
		}
		if (!found.has("on_review:e2e")) {
			const e2eScript = pkg.scripts["test:e2e"] ?? pkg.scripts.e2e;
			if (e2eScript) {
				const runner = pm ?? "npm";
				gates.push({
					name: "e2e",
					category: "on_review",
					gate: {
						command: `${runner} run ${pkg.scripts["test:e2e"] ? "test:e2e" : "e2e"}`,
						timeout: 120000,
					},
				});
				found.add("on_review:e2e");
			}
		}
	}

	// Coverage gate detection (devDeps-based, not config-file-based)
	if (!found.has("on_commit:coverage") && pkg) {
		const hasVitestCoverage =
			pkg.devDeps.has("@vitest/coverage-v8") || pkg.devDeps.has("@vitest/coverage-istanbul");
		const hasJestCoverage =
			pkg.devDeps.has("jest") && Object.values(pkg.scripts).some((s) => s.includes("--coverage"));

		if (hasVitestCoverage) {
			const runner = pm === "bun" ? "bun" : (pm ?? "npx");
			gates.push({
				name: "coverage",
				category: "on_commit",
				gate: {
					command:
						runner === "bun" ? "bun vitest run --coverage" : `${runner} vitest run --coverage`,
					timeout: 60000,
					run_once_per_batch: true,
				},
			});
			found.add("on_commit:coverage");
		} else if (hasJestCoverage) {
			const runner = pm ?? "npx";
			gates.push({
				name: "coverage",
				category: "on_commit",
				gate: {
					command: `${runner} jest --coverage`,
					timeout: 60000,
					run_once_per_batch: true,
				},
			});
			found.add("on_commit:coverage");
		}
	}

	// Python coverage (pytest-cov)
	if (!found.has("on_commit:coverage")) {
		try {
			if (hasPyprojectSection(root, "pytest") || existsSync(join(root, "pytest.ini"))) {
				const pyproject = join(root, "pyproject.toml");
				if (existsSync(pyproject)) {
					const content = readFileSync(pyproject, "utf-8");
					if (content.includes("pytest-cov") || content.includes("--cov")) {
						gates.push({
							name: "coverage",
							category: "on_commit",
							gate: {
								command: "pytest --cov",
								timeout: 60000,
								run_once_per_batch: true,
							},
						});
						found.add("on_commit:coverage");
					}
				}
			}
		} catch {
			/* fail-open */
		}
	}

	// Build GatesConfig
	const config: GatesConfig = {};
	for (const { name, category, gate } of gates) {
		if (!config[category]) config[category] = {};
		config[category]![name] = gate;
	}
	return config;
}

/** Returns true if gates config has any gates defined */
