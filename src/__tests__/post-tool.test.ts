import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-posttool-test");
const STATE_DIR = join(TEST_DIR, ".alfred", ".state");
let stdoutCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("postTool: Edit/Write gate execution", () => {
	it("adds pending-fixes when gate fails", async () => {
		writeFileSync(
			join(TEST_DIR, ".alfred", "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "echo 'lint error' && exit 1", timeout: 3000 } },
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.gate).toBe("lint");

		const output = stdoutCapture.join("");
		expect(output).toContain("lint error");
	});

	it("does not add pending-fixes when gate passes", async () => {
		writeFileSync(
			join(TEST_DIR, ".alfred", "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "echo ok", timeout: 3000 } },
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		expect(readPendingFixes().length).toBe(0);
	});

	it("does nothing when no gates configured", async () => {
		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		expect(readPendingFixes().length).toBe(0);
	});
});

describe("postTool: Bash handling", () => {
	it("resets pace on git commit", async () => {
		writeFileSync(
			join(TEST_DIR, ".alfred", "gates.json"),
			JSON.stringify({ on_write: { lint: { command: "echo ok" } } }),
		);

		// Set up pace with some files
		const { writePace } = await import("../state/session-state.ts");
		writePace({
			last_commit_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
			changed_files: 3,
			tool_calls: 10,
		});

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "test"' },
		});

		const { readPace } = await import("../state/session-state.ts");
		const pace = readPace();
		expect(pace!.changed_files).toBe(0);
	});

	it("records test pass for vitest command", async () => {
		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { stdout: "Tests passed\n5 tests", stderr: "" },
		});

		const { readLastTestPass } = await import("../state/session-state.ts");
		expect(readLastTestPass()).toBeTruthy();
	});

	it("tracks consecutive failures and suggests /clear", async () => {
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const errorEvent = {
			tool_name: "Bash",
			tool_input: { command: "npm run build" },
			tool_response: { stdout: "", stderr: "Build failed exit code 1" },
		};

		// First failure
		await postTool(errorEvent);
		// Second consecutive failure
		stdoutCapture = [];
		await postTool(errorEvent);

		const output = stdoutCapture.join("");
		expect(output).toContain("/clear");
	});
});
