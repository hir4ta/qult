import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-posttool-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
let stdoutCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
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
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "echo 'lint error' && exit 1", timeout: 3000 },
				},
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
			join(TEST_DIR, ".qult", "gates.json"),
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

describe("postTool: .qult/ file skip", () => {
	it("skips gate execution for files inside .qult/", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "echo 'lint error' && exit 1", timeout: 3000 },
				},
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Write",
			tool_input: { file_path: join(TEST_DIR, ".qult", "gates.json") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		expect(readPendingFixes().length).toBe(0);
		expect(stdoutCapture.join("")).toBe("");
	});
});

describe("postTool: non-gated extension skip", () => {
	it("skips per-file gate for .md files when gate uses biome", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "biome check {file} || exit 1", timeout: 3000 },
				},
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Write",
			tool_input: { file_path: join(TEST_DIR, "docs/README.md") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		expect(readPendingFixes().length).toBe(0);
	});
});

describe("postTool: Bash handling", () => {
	it("clears state on git commit", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({ on_write: { lint: { command: "echo ok" } } }),
		);

		const { recordTestPass, readSessionState } = await import("../state/session-state.ts");
		recordTestPass("vitest run");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "test"' },
		});

		const state = readSessionState();
		expect(state.test_passed_at).toBeNull();
		expect(state.changed_file_paths).toHaveLength(0);
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
});
