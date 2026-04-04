import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-posttool-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
let stdoutCapture: string[] = [];
let stderrCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];
	stderrCapture = [];

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((data) => {
		stderrCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
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

		// stdout is no longer used; state is written to pending-fixes.json
		expect(stdoutCapture.join("")).toBe("");
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

describe("postTool: test command detection from gates", () => {
	it("detects custom test command from on_commit gate", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_commit: { test: { command: "npm run test:integration", timeout: 30000 } },
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "npm run test:integration" },
			tool_response: { stdout: "All tests passed\nexit code 0", stderr: "" },
		});

		const { readLastTestPass } = await import("../state/session-state.ts");
		expect(readLastTestPass()).toBeTruthy();
	});

	it("detects test when bash command contains gate command", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_commit: { test: { command: "bun vitest run", timeout: 30000 } },
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run --reporter=verbose" },
			tool_response: { stdout: "Tests passed\nexit code 0", stderr: "" },
		});

		const { readLastTestPass } = await import("../state/session-state.ts");
		expect(readLastTestPass()).toBeTruthy();
	});

	it("falls back to TEST_CMD_RE when no on_commit gates", async () => {
		// No gates.json at all
		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { stdout: "Tests passed\nexit code 0", stderr: "" },
		});

		const { readLastTestPass } = await import("../state/session-state.ts");
		expect(readLastTestPass()).toBeTruthy();
	});

	it("does not fallback to regex when on_commit gates exist but command differs", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_commit: { test: { command: "npm run test:integration", timeout: 30000 } },
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		// "vitest" would match TEST_CMD_RE, but should NOT match since on_commit has a different command
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { stdout: "Tests passed", stderr: "" },
		});

		const { readLastTestPass } = await import("../state/session-state.ts");
		expect(readLastTestPass()).toBeFalsy();
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

	it("records test pass for vitest command with exit code 0", async () => {
		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { stdout: "Tests passed\n5 tests\nexit code 0", stderr: "" },
		});

		const { readLastTestPass } = await import("../state/session-state.ts");
		expect(readLastTestPass()).toBeTruthy();
	});

	it("does not record test pass without explicit exit code (false positive prevention)", async () => {
		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { stdout: "Tests passed\n5 tests", stderr: "" },
		});

		const { readLastTestPass } = await import("../state/session-state.ts");
		expect(readLastTestPass()).toBeNull();
	});
});

describe("postTool: disabled gate skip", () => {
	it("skips disabled gate — no pending-fixes created", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "echo 'lint error' && exit 1", timeout: 3000 },
				},
			}),
		);

		const { disableGate } = await import("../state/session-state.ts");
		disableGate("lint");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		expect(readPendingFixes().length).toBe(0);
	});
});

describe("postTool: gate execution summary to stderr", () => {
	it("outputs gate results after Edit", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
				},
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("[qult] gates:");
		expect(stderr).toContain("lint PASS");
	});

	it("shows FAIL and pending fix count on gate failure", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "echo 'error' && exit 1", timeout: 3000 },
				},
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("lint FAIL");
		expect(stderr).toContain("pending fix(es)");
	});
});

describe("postTool: 3-Strike gate failure escalation", () => {
	it("does not warn before 3 failures, warns on 3rd failure", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "echo 'error' && exit 1", timeout: 3000 },
				},
			}),
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		const { resetGatesCache } = await import("../gates/load.ts");
		const filePath = join(TEST_DIR, "src/broken.ts");

		// Fail twice — no 3-Strike warning yet
		for (let i = 0; i < 2; i++) {
			resetGatesCache();
			await postTool({
				tool_name: "Edit",
				tool_input: { file_path: filePath },
			});
		}
		const stderrAfter2 = stderrCapture.join("");
		expect(stderrAfter2).not.toContain("3-Strike");

		// Clear stderr before 3rd iteration for precise assertion
		stderrCapture = [];
		resetGatesCache();
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
		});
		const stderrOn3rd = stderrCapture.join("");
		expect(stderrOn3rd).toContain("3-Strike");
		expect(stderrOn3rd).toContain("lint");
		expect(stderrOn3rd).toContain("3 times");
	});
});

describe("postTool: hallucinated import detection", () => {
	beforeEach(() => {
		// Setup passing gates so gate execution doesn't interfere
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
				},
			}),
		);
	});

	it("creates pending-fix for nonexistent package import", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/test.ts"),
			'import { something } from "nonexistent-package-xyz";\nexport const x = 1;\n',
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/test.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		const importFix = fixes.find((f) => f.gate === "import-check");
		expect(importFix).toBeDefined();
		expect(importFix!.errors[0]).toContain("nonexistent-package-xyz");
	});

	it("does not flag relative imports", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/test.ts"),
			'import { foo } from "./foo.ts";\nimport { bar } from "../bar.ts";\nexport const x = 1;\n',
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/test.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const importFixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(importFixes).toHaveLength(0);
	});

	it("does not flag node: built-in imports", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/test.ts"),
			'import { readFileSync } from "node:fs";\nimport { join } from "path";\nexport const x = 1;\n',
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/test.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const importFixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(importFixes).toHaveLength(0);
	});

	it("skips non-TypeScript files", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/test.md"),
			'import { something } from "nonexistent-package";\n',
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/test.md") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const importFixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(importFixes).toHaveLength(0);
	});
});
