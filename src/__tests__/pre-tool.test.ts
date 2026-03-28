import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-pretool-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
let stdoutCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];
	exitCode = null;

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

describe("preTool: Edit/Write checks", () => {
	it("DENY editing other files when pending-fixes exist", async () => {
		const { writePendingFixes } = await import("../state/pending-fixes.ts");
		writePendingFixes([
			{ file: join(TEST_DIR, "src/broken.ts"), errors: ["type error"], gate: "typecheck" },
		]);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/other.ts") },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const output = stdoutCapture.join("");
		expect(output).toContain("permissionDecision");
	});

	it("allows editing the file with pending fixes", async () => {
		const fixFile = join(TEST_DIR, "src/broken.ts");
		const { writePendingFixes } = await import("../state/pending-fixes.ts");
		writePendingFixes([{ file: fixFile, errors: ["err"], gate: "lint" }]);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: fixFile },
		});

		expect(exitCode).toBeNull();
	});

	it("allows Edit when no pending fixes", async () => {
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		expect(exitCode).toBeNull();
	});
});

describe("preTool: Bash git commit checks", () => {
	it("DENY commit without test pass when on_commit gates exist", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({ on_commit: { test: { command: "vitest run", timeout: 30000 } } }),
		);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Bash",
				tool_input: { command: 'git commit -m "test"' },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const output = stdoutCapture.join("");
		expect(output).toContain("test");
	});

	it("allows commit without review for small change", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({ on_commit: { test: { command: "vitest run", timeout: 30000 } } }),
		);

		const { recordTestPass } = await import("../state/session-state.ts");
		recordTestPass("vitest run");

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "test"' },
		});

		expect(exitCode).toBeNull();
	});

	it("DENY commit without review when plan is active", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({ on_commit: { test: { command: "vitest run", timeout: 30000 } } }),
		);

		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: test [pending]\n- **File**: foo.ts\n",
		);

		const { recordTestPass } = await import("../state/session-state.ts");
		recordTestPass("vitest run");

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Bash",
				tool_input: { command: 'git commit -m "planned change"' },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const output = stdoutCapture.join("");
		expect(output).toContain("review");
	});

	it("DENY commit without review when many gated files changed", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
				on_commit: { test: { command: "vitest run", timeout: 30000 } },
			}),
		);

		const { recordChangedFile, recordTestPass } = await import("../state/session-state.ts");
		recordTestPass("vitest run");
		for (let i = 0; i < 6; i++) {
			recordChangedFile(`/project/src/file${i}.ts`);
		}

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Bash",
				tool_input: { command: 'git commit -m "large change"' },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const output = stdoutCapture.join("");
		expect(output).toContain("review");
	});

	it("allows non-commit Bash commands", async () => {
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: "ls -la" },
		});

		expect(exitCode).toBeNull();
	});
});
