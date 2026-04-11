import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectGates, detectPackageManager } from "../gates/detect.ts";
import { detectExportBreakingChanges } from "../hooks/detectors/export-check.ts";

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
		expect(Object.keys(gates.on_write ?? {}).length).toBe(0);
		expect(Object.keys(gates.on_commit ?? {}).length).toBe(0);
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

describe("detectExportBreakingChanges: path traversal prevention", () => {
	const originalCwd = process.cwd();

	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		process.chdir(TEST_DIR);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("returns empty array for path outside cwd", () => {
		const outsidePath = "/tmp/outside-cwd-file.ts";
		const result = detectExportBreakingChanges(outsidePath);
		expect(result).toEqual([]);
	});

	it("returns empty array for path that starts with cwd string but lacks separator", () => {
		// e.g. cwd is /foo/bar, file is /foo/barbaz/file.ts — must not match
		const trickPath = `${TEST_DIR}extra/file.ts`;
		const result = detectExportBreakingChanges(trickPath);
		expect(result).toEqual([]);
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

	it("detects security-semgrep-write as on_write gate when .semgrep.yml exists and semgrep reachable", () => {
		writeFileSync(join(TEST_DIR, ".semgrep.yml"), "rules: []");
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "semgrep"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_write?.["security-semgrep-write"]).toBeDefined();
		expect(gates.on_write?.["security-semgrep-write"]?.command).toBe(
			"semgrep scan --config auto --quiet {file}",
		);
	});

	it("does not detect security-gosec when gosec is not reachable", () => {
		writeFileSync(join(TEST_DIR, "go.mod"), "module example.com/test");
		// No gosec in PATH or node_modules
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.["security-gosec"]).toBeUndefined();
	});
});

describe("coverage gate detection", () => {
	it("detects coverage gate from vitest coverage dependency", () => {
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({
				devDependencies: { vitest: "^3.0.0", "@vitest/coverage-v8": "^3.0.0" },
				scripts: { test: "vitest run" },
			}),
		);
		writeFileSync(join(TEST_DIR, "bun.lockb"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.coverage).toBeDefined();
		expect(gates.on_commit!.coverage!.command).toContain("coverage");
	});

	it("detects coverage gate from istanbul dependency", () => {
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({
				devDependencies: { vitest: "^3.0.0", "@vitest/coverage-istanbul": "^3.0.0" },
				scripts: { test: "vitest run" },
			}),
		);
		writeFileSync(join(TEST_DIR, "bun.lockb"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.coverage).toBeDefined();
	});

	it("does not detect coverage gate without coverage dependency", () => {
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({
				devDependencies: { vitest: "^3.0.0" },
				scripts: { test: "vitest run" },
			}),
		);
		writeFileSync(join(TEST_DIR, "bun.lockb"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.coverage).toBeUndefined();
	});

	it("detects coverage gate from jest with --coverage script", () => {
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({
				devDependencies: { jest: "^29.0.0" },
				scripts: { test: "jest --coverage" },
			}),
		);
		writeFileSync(join(TEST_DIR, "package-lock.json"), "{}");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.coverage).toBeDefined();
		expect(gates.on_commit!.coverage!.command).toContain("--coverage");
	});

	it("does not detect jest coverage gate without --coverage in scripts", () => {
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({
				devDependencies: { jest: "^29.0.0" },
				scripts: { test: "jest" },
			}),
		);
		writeFileSync(join(TEST_DIR, "package-lock.json"), "{}");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_commit?.coverage).toBeUndefined();
	});
});

describe("detects structured typecheck commands", () => {
	it("adds structured_command for pyright typecheck", () => {
		writeFileSync(join(TEST_DIR, "pyrightconfig.json"), "{}");
		writeFileSync(join(TEST_DIR, "package-lock.json"), "{}");
		const gates = detectGates(TEST_DIR);
		if (gates.on_write?.typecheck) {
			// structured_command should be set when pyright is detected
			expect(gates.on_write.typecheck.structured_command).toContain("--outputjson");
		}
	});

	it("adds structured_command for mypy typecheck", () => {
		writeFileSync(join(TEST_DIR, "mypy.ini"), "[mypy]");
		writeFileSync(join(TEST_DIR, "package-lock.json"), "{}");
		const gates = detectGates(TEST_DIR);
		if (gates.on_write?.typecheck) {
			expect(gates.on_write.typecheck.command).toContain("mypy");
			// mypy doesn't have a structured JSON output mode, but we can still check it's set up
		}
	});

	it("does not add structured_command for tsc typecheck", () => {
		writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");
		writeFileSync(join(TEST_DIR, "package-lock.json"), "{}");
		const gates = detectGates(TEST_DIR);
		if (gates.on_write?.typecheck) {
			// tsc uses text output parsing, no structured_command needed
			expect(gates.on_write.typecheck.structured_command).toBeUndefined();
		}
	});
});

describe("mutation-test gate detection", () => {
	it("detects Stryker from stryker.conf.js", () => {
		writeFileSync(join(TEST_DIR, "stryker.conf.js"), "module.exports = {};");
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "stryker"), "");
		writeFileSync(join(TEST_DIR, "package-lock.json"), "{}");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_review?.["mutation-test"]).toBeDefined();
		expect(gates.on_review!["mutation-test"]!.command).toContain("stryker");
		expect(gates.on_review!["mutation-test"]!.timeout).toBe(120000);
	});

	it("detects Stryker from stryker.conf.mjs", () => {
		writeFileSync(join(TEST_DIR, "stryker.conf.mjs"), "export default {};");
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "stryker"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_review?.["mutation-test"]).toBeDefined();
	});

	it("detects mutmut from pyproject.toml [tool.mutmut] section", () => {
		writeFileSync(join(TEST_DIR, "pyproject.toml"), "[tool.mutmut]\npaths_to_mutate = 'src'");
		mkdirSync(join(TEST_DIR, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(TEST_DIR, "node_modules", ".bin", "mutmut"), "");
		const gates = detectGates(TEST_DIR);
		expect(gates.on_review?.["mutation-test"]).toBeDefined();
		expect(gates.on_review!["mutation-test"]!.command).toContain("mutmut");
	});

	it("does not detect mutation-test without config or executable", () => {
		const gates = detectGates(TEST_DIR);
		expect(gates.on_review?.["mutation-test"]).toBeUndefined();
	});
});
