import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-pretool-test");
const STATE_DIR = join(TEST_DIR, ".alfred", ".state");
let stdoutCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
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

	it("DENY when pace is red (>120 min, 15+ files)", async () => {
		const { writePace } = await import("../state/session-state.ts");
		writePace({
			last_commit_at: new Date(Date.now() - 125 * 60 * 1000).toISOString(),
			changed_files: 16,
			tool_calls: 80,
		});

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
	});

	it("allows Edit when no pending fixes and pace ok", async () => {
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
			join(TEST_DIR, ".alfred", "gates.json"),
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

	it("allows commit without review for small change (test pass, no plan, few files)", async () => {
		writeFileSync(
			join(TEST_DIR, ".alfred", "gates.json"),
			JSON.stringify({ on_commit: { test: { command: "vitest run", timeout: 30000 } } }),
		);

		// Record test pass but not review — small change (no plan, 0 changed files)
		const { recordTestPass } = await import("../state/session-state.ts");
		recordTestPass("vitest run");

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "test"' },
		});

		// Small change — review not required
		expect(exitCode).toBeNull();
	});

	it("allows commit without review at boundary (4 files changed, no plan)", async () => {
		writeFileSync(
			join(TEST_DIR, ".alfred", "gates.json"),
			JSON.stringify({ on_commit: { test: { command: "vitest run", timeout: 30000 } } }),
		);

		// Record test pass + set pace to 4 files (just below threshold of 5)
		const { recordTestPass, writePace } = await import("../state/session-state.ts");
		recordTestPass("vitest run");
		writePace({
			last_commit_at: new Date().toISOString(),
			changed_files: 4,
			tool_calls: 10,
		});

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "small fix"' },
		});

		// Should NOT be denied — small change doesn't require review
		expect(exitCode).toBeNull();
	});

	it("DENY commit without review when plan is active", async () => {
		writeFileSync(
			join(TEST_DIR, ".alfred", "gates.json"),
			JSON.stringify({ on_commit: { test: { command: "vitest run", timeout: 30000 } } }),
		);

		// Create a plan file
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: test [pending]\n- **File**: foo.ts\n",
		);

		// Record test pass but not review — plan is active
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
			join(TEST_DIR, ".alfred", "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
				on_commit: { test: { command: "vitest run", timeout: 30000 } },
			}),
		);

		// Record test pass + 6 gated files (above threshold)
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
