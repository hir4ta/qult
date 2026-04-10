import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatesCache, saveGates } from "../gates/load.ts";
import { closeDb, setProjectPath, useTestDb } from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";
import { flush as flushPendingFixes, writePendingFixes } from "../state/pending-fixes.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-integration-test");
const originalCwd = process.cwd();
let stdoutCapture: string[];
let stderrCapture: string[];
let exitCode: number | null;

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });

	// Create a minimal gates config with real biome
	saveGates({
		on_write: {
			lint: {
				command: "biome check {file} --no-errors-on-unmatched",
				timeout: 5000,
			},
		},
	});
	resetAllCaches();

	// Initialize empty pending fixes
	writePendingFixes([]);
	flushPendingFixes();
	resetAllCaches();

	// Need biome.json for biome to work
	writeFileSync(
		join(TEST_DIR, "biome.json"),
		JSON.stringify({
			linter: { rules: { correctness: { noUnusedImports: "error" } } },
			files: { includes: ["**/*.ts"] },
		}),
	);
	process.chdir(TEST_DIR);

	stdoutCapture = [];
	stderrCapture = [];
	exitCode = null;
	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((data) => {
		stderrCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exitCode = code as number;
		throw new Error(`process.exit(${code})`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	closeDb();
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Integration: real biome gate", () => {
	it("passes clean TypeScript file through biome", async () => {
		// Create a clean TS file
		writeFileSync(join(TEST_DIR, "clean.ts"), "export const x = 1;\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "clean.ts") },
			session_id: "integration-test",
		});

		// No pending fixes should be created for clean code
		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		expect(readPendingFixes()).toHaveLength(0);
	});

	it("detects lint error and creates pending fix, then blocks other file edits", async () => {
		// Create a file with unused import (biome error)
		writeFileSync(
			join(TEST_DIR, "broken.ts"),
			'import { readFileSync } from "node:fs";\nexport const x = 1;\n',
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "broken.ts") },
			session_id: "integration-test",
		});

		// Should have pending fixes
		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.file).toContain("broken.ts");

		// Now try to edit another file — should be DENIED
		stdoutCapture = [];
		exitCode = null;

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "other.ts") },
			});
		} catch {
			// process.exit(2)
		}

		expect(exitCode).toBe(2);
	});
});

describe("Integration: real tsc gate", { timeout: 15000 }, () => {
	beforeEach(() => {
		// Configure tsc as typecheck gate
		saveGates({
			on_write: {
				typecheck: {
					command: `bun tsc --noEmit --project ${join(TEST_DIR, "tsconfig.json")}`,
					timeout: 10000,
				},
			},
		});
		resetGatesCache();
		// Minimal tsconfig.json
		writeFileSync(
			join(TEST_DIR, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "bundler",
				},
				include: ["*.ts"],
			}),
		);
	});

	it("passes clean TypeScript file", async () => {
		writeFileSync(join(TEST_DIR, "clean.ts"), "export const x: number = 1;\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "clean.ts") },
			session_id: "integration-tsc",
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		expect(readPendingFixes()).toHaveLength(0);
	});

	it("detects type error and creates pending fix", async () => {
		writeFileSync(join(TEST_DIR, "broken.ts"), 'export const x: number = "not a number";\n');

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "broken.ts") },
			session_id: "integration-tsc",
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.gate).toBe("typecheck");
	});
});

describe("Integration: test command detection", () => {
	it("records test pass when vitest command succeeds", async () => {
		saveGates({
			on_commit: {
				test: { command: "bun vitest run", timeout: 10000 },
			},
		});
		resetGatesCache();

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { stdout: "Tests passed\nexit code 0", stderr: "" },
			session_id: "integration-test-detect",
		});

		const { readSessionState } = await import("../state/session-state.ts");
		const state = readSessionState();
		expect(state.test_passed_at).not.toBeNull();
		expect(state.test_command).toBe("bun vitest run");
	});

	it("does not record test pass when exit code is non-zero", async () => {
		saveGates({
			on_commit: {
				test: { command: "bun vitest run", timeout: 10000 },
			},
		});
		resetGatesCache();

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { stdout: "FAIL\nexit code 1", stderr: "" },
			session_id: "integration-test-detect",
		});

		const { readSessionState } = await import("../state/session-state.ts");
		const state = readSessionState();
		expect(state.test_passed_at).toBeNull();
	});
});
