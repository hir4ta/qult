import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectGates,
	detectPackageManager,
	formatDetectionSummary,
	hasAnyGates,
} from "../gates/detect.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-detect-test");

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("detectPackageManager", () => {
	it("detects bun from bun.lockb", () => {
		writeFileSync(join(TEST_DIR, "bun.lockb"), "");
		expect(detectPackageManager(TEST_DIR)).toBe("bun");
	});

	it("detects npm from package-lock.json", () => {
		writeFileSync(join(TEST_DIR, "package-lock.json"), "{}");
		expect(detectPackageManager(TEST_DIR)).toBe("npm");
	});

	it("detects pnpm from pnpm-lock.yaml", () => {
		writeFileSync(join(TEST_DIR, "pnpm-lock.yaml"), "");
		expect(detectPackageManager(TEST_DIR)).toBe("pnpm");
	});

	it("returns null when no lockfile found", () => {
		expect(detectPackageManager(TEST_DIR)).toBeNull();
	});
});

describe("detectGates", () => {
	it("returns empty config for empty project", () => {
		const gates = detectGates(TEST_DIR);
		expect(hasAnyGates(gates)).toBe(false);
	});

	it("detects biome from biome.json", () => {
		writeFileSync(join(TEST_DIR, "biome.json"), "{}");
		// Create a fake node_modules/.bin/biome
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "biome"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_write?.lint?.command).toBe("biome check {file}");
	});

	it("detects tsconfig.json as typecheck gate", () => {
		writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");
		writeFileSync(join(TEST_DIR, "bun.lockb"), "");
		// tsc needs to be reachable
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "tsc"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_write?.typecheck?.command).toBe("bun tsc --noEmit");
		expect(gates.on_write?.typecheck?.run_once_per_batch).toBe(true);
	});

	it("detects vitest from vitest.config.ts", () => {
		writeFileSync(join(TEST_DIR, "vitest.config.ts"), "");
		writeFileSync(join(TEST_DIR, "bun.lockb"), "");
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "vitest"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.test?.command).toBe("bun vitest run");
	});

	it("falls back to package.json scripts", () => {
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({
				scripts: { lint: "custom-lint", test: "custom-test" },
			}),
		);
		writeFileSync(join(TEST_DIR, "bun.lockb"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_write?.lint?.command).toBe("bun run lint");
		expect(gates.on_commit?.test?.command).toBe("bun run test");
	});

	it("prefers config file over package.json scripts", () => {
		writeFileSync(join(TEST_DIR, "biome.json"), "{}");
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({
				scripts: { lint: "custom-lint" },
			}),
		);
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "biome"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_write?.lint?.command).toBe("biome check {file}");
	});

	it("detects go project from go.mod", () => {
		writeFileSync(join(TEST_DIR, "go.mod"), "module example.com/test");
		const gates = detectGates(TEST_DIR);
		// go vet: needs 'go' in PATH (likely available on dev machines)
		if (gates.on_write?.typecheck) {
			expect(gates.on_write.typecheck.command).toBe("go vet ./...");
		}
		if (gates.on_commit?.test) {
			expect(gates.on_commit.test.command).toBe("go test ./...");
		}
	});

	it("detects devDependencies as fallback for vitest", () => {
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({
				devDependencies: { vitest: "^3" },
			}),
		);
		writeFileSync(join(TEST_DIR, "bun.lockb"), "");
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "vitest"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.test?.command).toBe("bun vitest run");
	});
});

describe("security gate detection", () => {
	it("detects security-semgrep when .semgrep.yml exists and semgrep reachable", () => {
		writeFileSync(join(TEST_DIR, ".semgrep.yml"), "rules: []");
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "semgrep"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.["security-semgrep"]).toBeDefined();
		expect(gates.on_commit?.["security-semgrep"]?.command).toContain("semgrep");
		expect(gates.on_commit?.["security-semgrep"]?.run_once_per_batch).toBe(true);
	});

	it("detects security-gitleaks when .gitleaks.toml exists", () => {
		writeFileSync(join(TEST_DIR, ".gitleaks.toml"), "[allowlist]");
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "gitleaks"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.["security-gitleaks"]).toBeDefined();
		expect(gates.on_commit?.["security-gitleaks"]?.command).toContain("gitleaks");
	});

	it("does not detect security-gosec when gosec is not reachable", () => {
		writeFileSync(join(TEST_DIR, "go.mod"), "module example.com/test");
		// No gosec in PATH or node_modules
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.["security-gosec"]).toBeUndefined();
	});
});

describe("formatDetectionSummary", () => {
	it("formats counts correctly", () => {
		const gates = {
			on_write: { lint: { command: "biome check {file}" } },
			on_commit: { test: { command: "vitest run" } },
		};
		expect(formatDetectionSummary(gates)).toBe("Gates detected: 1 on_write, 1 on_commit");
	});

	it("reports no gates", () => {
		expect(formatDetectionSummary({})).toBe("No gates detected");
	});
});
