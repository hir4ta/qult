import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GatesConfig } from "../types.ts";

/** Auto-detect gates from project configuration files */
export function detectGates(projectRoot: string): GatesConfig {
	const gates: GatesConfig = { on_write: {}, on_commit: {} };

	// Linter
	if (existsSync(join(projectRoot, "biome.json")) || existsSync(join(projectRoot, "biome.jsonc"))) {
		gates.on_write!.lint = {
			command: "biome check {file} --no-errors-on-unmatched",
			timeout: 3000,
		};
	} else if (
		existsSync(join(projectRoot, ".eslintrc.json")) ||
		existsSync(join(projectRoot, ".eslintrc.js")) ||
		existsSync(join(projectRoot, "eslint.config.js")) ||
		existsSync(join(projectRoot, "eslint.config.mjs"))
	) {
		gates.on_write!.lint = { command: "eslint {file}", timeout: 5000 };
	}

	// TypeScript
	if (existsSync(join(projectRoot, "tsconfig.json"))) {
		gates.on_write!.typecheck = {
			command: "tsc --noEmit",
			timeout: 10000,
			run_once_per_batch: true,
		};
	}

	// Test framework
	const pkgPath = join(projectRoot, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };

			if (deps.vitest) {
				gates.on_commit!.test = {
					command: "bunx --bun vitest --changed --reporter=verbose",
					timeout: 30000,
				};
			} else if (deps.jest) {
				gates.on_commit!.test = {
					command: "jest --changedSince=HEAD~1",
					timeout: 30000,
				};
			}
		} catch {
			// ignore parse errors
		}
	}

	// Go
	if (existsSync(join(projectRoot, "go.mod"))) {
		gates.on_commit!.test = { command: "go test ./...", timeout: 30000 };
	}

	// Rust
	if (existsSync(join(projectRoot, "Cargo.toml"))) {
		gates.on_commit!.test = { command: "cargo test", timeout: 60000 };
	}

	return gates;
}
