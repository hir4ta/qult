/**
 * Project profiling — auto-detect language, test framework, linter, build system.
 * Used by SessionStart hook and `alfred profile` MCP action.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectProfile {
	languages: string[];
	runtime: string;
	testFramework: string;
	testPattern: string;
	linter: string;
	buildSystem: string;
	detectedAt: string;
}

export function detectProjectProfile(cwd: string): ProjectProfile {
	const profile: ProjectProfile = {
		languages: [],
		runtime: "unknown",
		testFramework: "unknown",
		testPattern: "",
		linter: "unknown",
		buildSystem: "unknown",
		detectedAt: new Date().toISOString(),
	};

	// Read package.json
	const pkgPath = join(cwd, "package.json");
	let pkg: Record<string, unknown> = {};
	if (existsSync(pkgPath)) {
		try {
			pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		} catch {
			/* invalid JSON */
		}
	}

	const allDeps = {
		...((pkg.dependencies as Record<string, string>) ?? {}),
		...((pkg.devDependencies as Record<string, string>) ?? {}),
	};

	// Language detection
	if (existsSync(join(cwd, "tsconfig.json"))) {
		profile.languages.push("typescript");
	}
	if (pkg.type === "module" || existsSync(join(cwd, "package.json"))) {
		if (!profile.languages.includes("typescript")) {
			profile.languages.push("javascript");
		}
	}
	if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
		profile.languages.push("python");
	}
	if (existsSync(join(cwd, "go.mod"))) {
		profile.languages.push("go");
	}
	if (existsSync(join(cwd, "Cargo.toml"))) {
		profile.languages.push("rust");
	}

	// Runtime
	if (existsSync(join(cwd, "bunfig.toml")) || allDeps["@types/bun"]) {
		profile.runtime = "bun";
	} else if (existsSync(join(cwd, "deno.json")) || existsSync(join(cwd, "deno.jsonc"))) {
		profile.runtime = "deno";
	} else if (existsSync(join(cwd, "package.json"))) {
		profile.runtime = "node";
	}

	// Test framework
	if (allDeps.vitest) {
		profile.testFramework = "vitest";
		profile.testPattern = "*.test.ts";
	} else if (allDeps.jest || allDeps["@jest/core"]) {
		profile.testFramework = "jest";
		profile.testPattern = "*.test.ts";
	} else if (allDeps.mocha) {
		profile.testFramework = "mocha";
		profile.testPattern = "*.test.ts";
	} else if (existsSync(join(cwd, "pyproject.toml"))) {
		profile.testFramework = "pytest";
		profile.testPattern = "test_*.py";
	} else if (existsSync(join(cwd, "go.mod"))) {
		profile.testFramework = "go test";
		profile.testPattern = "*_test.go";
	} else if (existsSync(join(cwd, "Cargo.toml"))) {
		profile.testFramework = "cargo test";
		profile.testPattern = ""; // Rust tests are inline
	}

	// Linter
	if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
		profile.linter = "biome";
	} else if (
		allDeps.eslint ||
		existsSync(join(cwd, ".eslintrc.json")) ||
		existsSync(join(cwd, ".eslintrc.js"))
	) {
		profile.linter = "eslint";
	} else if (existsSync(join(cwd, "pyproject.toml"))) {
		// Check for ruff in pyproject.toml
		try {
			const pyproj = readFileSync(join(cwd, "pyproject.toml"), "utf-8");
			if (pyproj.includes("[tool.ruff]")) profile.linter = "ruff";
		} catch {
			/* ignore */
		}
	} else if (existsSync(join(cwd, "Cargo.toml"))) {
		profile.linter = "clippy";
	}

	// Build system
	if (existsSync(join(cwd, "Taskfile.yml")) || existsSync(join(cwd, "Taskfile.yaml"))) {
		profile.buildSystem = "taskfile";
	} else if (existsSync(join(cwd, "Makefile"))) {
		profile.buildSystem = "make";
	} else if (allDeps.vite) {
		profile.buildSystem = "vite";
	} else if (existsSync(join(cwd, "package.json"))) {
		profile.buildSystem = "npm scripts";
	}

	return profile;
}
