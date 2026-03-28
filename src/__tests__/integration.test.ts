import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-integration-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const originalCwd = process.cwd();
let stdoutCapture: string[];
let stderrCapture: string[];
let exitCode: number | null;

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	// Create a minimal gates.json with real biome
	writeFileSync(
		join(TEST_DIR, ".qult", "gates.json"),
		JSON.stringify({
			on_write: {
				lint: {
					command: "biome check {file} --no-errors-on-unmatched",
					timeout: 5000,
				},
			},
		}),
	);
	writeFileSync(join(STATE_DIR, "pending-fixes.json"), "[]");
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
