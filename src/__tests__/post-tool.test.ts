import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveGates } from "../gates/load.ts";
import { closeDb, getDb, getProjectId, setProjectPath, useTestDb } from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";
import type { GatesConfig } from "../types.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-posttool-test");
let stdoutCapture: string[] = [];
let stderrCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	resetAllCaches();
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
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
	closeDb();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("postTool: Edit/Write gate execution", () => {
	it("adds pending-fixes when gate fails", async () => {
		saveGates({
			on_write: {
				lint: { command: "echo 'lint error' && exit 1", timeout: 3000 },
			},
		} as GatesConfig);
		resetAllCaches();

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
		saveGates({
			on_write: { lint: { command: "echo ok", timeout: 3000 } },
		} as GatesConfig);
		resetAllCaches();

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

describe("postTool: non-gated extension skip", () => {
	it("skips per-file gate for .md files when gate uses biome", async () => {
		saveGates({
			on_write: {
				lint: { command: "biome check {file} || exit 1", timeout: 3000 },
			},
		} as GatesConfig);
		resetAllCaches();

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
		saveGates({
			on_commit: { test: { command: "npm run test:integration", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

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
		saveGates({
			on_commit: { test: { command: "bun vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

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
		saveGates({
			on_commit: { test: { command: "npm run test:integration", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

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
		saveGates({ on_write: { lint: { command: "echo ok" } } } as GatesConfig);
		resetAllCaches();

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

	it("records test pass using structured exitCode field (Task 5)", async () => {
		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { exitCode: 0 },
		});

		const { readLastTestPass } = await import("../state/session-state.ts");
		expect(readLastTestPass()).toBeTruthy();
	});

	it("does not record test pass when structured exitCode is non-zero", async () => {
		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { exitCode: 1 },
		});

		const { readLastTestPass } = await import("../state/session-state.ts");
		expect(readLastTestPass()).toBeNull();
	});
});

describe("postTool: install command detection", () => {
	it("detects npm install and runs hallucinated-package-check", async () => {
		// Use the real modules — mock at the network/CLI level instead
		// The hallucinated-package-check uses fetch, which we can stub globally
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "npm install totally-nonexistent-pkg-12345" },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "hallucinated-package-check")).toBe(true);
	});

	it("does not trigger install detection for git commit", async () => {
		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "test"' },
		});

		// git commit triggers onGitCommit and returns early — no install detection
		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "hallucinated-package-check")).toBe(false);
	});

	it("skips dep-vuln-check when gate is disabled", async () => {
		const { disableGate } = await import("../state/session-state.ts");
		disableGate("dep-vuln-check");

		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "npm install some-pkg" },
		});

		// No dep-vuln-check fixes should be generated (gate disabled)
		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "dep-vuln-check")).toBe(false);
	});
});

describe("postTool: disabled gate skip", () => {
	it("skips disabled gate — no pending-fixes created", async () => {
		saveGates({
			on_write: {
				lint: { command: "echo 'lint error' && exit 1", timeout: 3000 },
			},
		} as GatesConfig);
		resetAllCaches();

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
		saveGates({
			on_write: {
				lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
			},
		} as GatesConfig);
		resetAllCaches();

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
		saveGates({
			on_write: {
				lint: { command: "echo 'error' && exit 1", timeout: 3000 },
			},
		} as GatesConfig);
		resetAllCaches();

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
		saveGates({
			on_write: {
				lint: { command: "echo 'error' && exit 1", timeout: 3000 },
			},
		} as GatesConfig);
		resetAllCaches();

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
		saveGates({
			on_write: {
				lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
			},
		} as GatesConfig);
		resetAllCaches();
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

describe("postTool: Python hallucinated import detection", () => {
	beforeEach(() => {
		saveGates({
			on_write: { lint: { command: "echo 'OK' && exit 0", timeout: 3000 } },
		} as GatesConfig);
		resetAllCaches();
	});

	it("flags import of nonexistent module", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/app.py"), "import nonexistent_module\nx = 1\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/app.py") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(fixes).toHaveLength(1);
		expect(fixes[0]!.errors[0]).toContain("nonexistent_module");
	});

	it("flags from X import Y for nonexistent module", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/app.py"), "from nonexistent_module import foo\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/app.py") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(fixes).toHaveLength(1);
		expect(fixes[0]!.errors[0]).toContain("nonexistent_module");
	});

	it("does not flag stdlib import os", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/app.py"), "import os\nimport sys\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/app.py") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(fixes).toHaveLength(0);
	});

	it("does not flag from pathlib import Path (stdlib)", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/app.py"), "from pathlib import Path\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/app.py") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(fixes).toHaveLength(0);
	});

	it("does not flag import when module file exists in project", async () => {
		writeFileSync(join(TEST_DIR, "mymodule.py"), "# local module\n");
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/app.py"), "import mymodule\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/app.py") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(fixes).toHaveLength(0);
	});
});

describe("postTool: Go hallucinated import detection", () => {
	beforeEach(() => {
		saveGates({
			on_write: { lint: { command: "echo 'OK' && exit 0", timeout: 3000 } },
		} as GatesConfig);
		resetAllCaches();
	});

	it("flags nonexistent third-party import", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/main.go"),
			'package main\n\nimport "github.com/nonexistent/pkg"\n',
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/main.go") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(fixes).toHaveLength(1);
		expect(fixes[0]!.errors[0]).toContain("github.com/nonexistent/pkg");
	});

	it("does not flag stdlib import fmt", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/main.go"), 'package main\n\nimport "fmt"\nimport "os"\n');

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/main.go") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(fixes).toHaveLength(0);
	});

	it("handles multiline import block", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/main.go"),
			'package main\n\nimport (\n\t"fmt"\n\t"github.com/nonexistent/pkg"\n)\n',
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/main.go") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(fixes).toHaveLength(1);
		expect(fixes[0]!.errors[0]).toContain("github.com/nonexistent/pkg");
	});

	it("does not flag when go.sum contains the module", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/main.go"),
			'package main\n\nimport "github.com/existing/pkg"\n',
		);
		writeFileSync(
			join(TEST_DIR, "go.sum"),
			"github.com/existing/pkg v1.0.0 h1:abc=\ngithub.com/existing/pkg v1.0.0/go.mod h1:def=\n",
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/main.go") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes().filter((f) => f.gate === "import-check");
		expect(fixes).toHaveLength(0);
	});
});

describe("postTool: export breaking change detection", () => {
	beforeEach(() => {
		saveGates({
			on_write: { lint: { command: "echo ok && exit 0", timeout: 3000 } },
		} as GatesConfig);
		resetAllCaches();
	});

	it("detects removed export and creates pending-fix", async () => {
		// Setup: create a git repo with initial file
		const { execSync } = await import("node:child_process");
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/api.ts"),
			"export function hello() {}\nexport function goodbye() {}\n",
		);
		execSync(
			"git init && git config user.email test@test && git config user.name test && git add -A && git commit -m init",
			{
				cwd: TEST_DIR,
				stdio: "ignore",
			},
		);

		// Now remove an export
		writeFileSync(join(TEST_DIR, "src/api.ts"), "export function hello() {}\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/api.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const exportFixes = readPendingFixes().filter((f) => f.gate === "export-check");
		expect(exportFixes).toHaveLength(1);
		expect(exportFixes[0]!.errors[0]).toContain("goodbye");
	});

	it("does not flag when no exports are removed", async () => {
		const { execSync } = await import("node:child_process");
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/api.ts"), "export function hello() {}\n");
		execSync(
			"git init && git config user.email test@test && git config user.name test && git add -A && git commit -m init",
			{
				cwd: TEST_DIR,
				stdio: "ignore",
			},
		);

		// Add a new export (no removal)
		writeFileSync(
			join(TEST_DIR, "src/api.ts"),
			"export function hello() {}\nexport function world() {}\n",
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/api.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const exportFixes = readPendingFixes().filter((f) => f.gate === "export-check");
		expect(exportFixes).toHaveLength(0);
	});

	it("fail-open when file not in git", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/new.ts"), "export function fresh() {}\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/new.ts") },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const exportFixes = readPendingFixes().filter((f) => f.gate === "export-check");
		expect(exportFixes).toHaveLength(0);
	});
});

describe("postTool: convention drift detection", () => {
	beforeEach(() => {
		saveGates({
			on_write: { lint: { command: "echo ok && exit 0", timeout: 3000 } },
		} as GatesConfig);
		resetAllCaches();
	});

	it("warns when new file uses different naming convention than siblings", async () => {
		const dir = join(TEST_DIR, "src");
		mkdirSync(dir, { recursive: true });
		// Create kebab-case siblings
		writeFileSync(join(dir, "my-utils.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "api-client.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "data-store.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "event-bus.ts"), "export const x = 1;\n");
		// New file is camelCase — should warn
		writeFileSync(join(dir, "myHelper.ts"), "export const x = 1;\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(dir, "myHelper.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Convention");
	});

	it("does not warn when naming matches dominant convention", async () => {
		const dir = join(TEST_DIR, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "my-utils.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "api-client.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "data-store.ts"), "export const x = 1;\n");
		// New file matches kebab-case
		writeFileSync(join(dir, "new-thing.ts"), "export const x = 1;\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(dir, "new-thing.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("Convention");
	});

	it("does not warn for directories with fewer than 3 siblings", async () => {
		const dir = join(TEST_DIR, "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "myHelper.ts"), "export const x = 1;\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(dir, "myHelper.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("Convention");
	});
});

describe("postTool: over-engineering detection", () => {
	beforeEach(() => {
		saveGates({
			on_write: { lint: { command: "echo ok && exit 0", timeout: 3000 } },
		} as GatesConfig);
		resetAllCaches();
	});

	it("warns when unplanned file count exceeds threshold", async () => {
		// Setup plan with 2 task files
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: A [pending]",
				"- **File**: src/a.ts",
				"### Task 2: B [pending]",
				"- **File**: src/b.ts",
			].join("\n"),
		);

		// Populate changed_file_paths with 2 planned + 6 unplanned files
		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile(join(TEST_DIR, "src/a.ts"));
		recordChangedFile(join(TEST_DIR, "src/b.ts"));
		for (let i = 0; i < 6; i++) {
			recordChangedFile(join(TEST_DIR, `src/extra${i}.ts`));
		}

		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/extra6.ts"), "export const x = 1;\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/extra6.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Over-engineering");
	});

	it("does not warn when all changed files are in plan scope", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			["## Tasks", "### Task 1: A [pending]", "- **File**: src/a.ts"].join("\n"),
		);

		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/a.ts"), "export const x = 1;\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("Over-engineering");
	});

	it("does not warn when no plan is active", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/foo.ts"), "export const x = 1;\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("Over-engineering");
	});
});

describe("postTool: iterative security escalation", () => {
	it("promotes advisory to blocking after N edits to same file", async () => {
		// Create a file with advisory pattern (API route without auth)
		const file = join(TEST_DIR, "routes.ts");
		writeFileSync(file, `app.get("/api/users", handler);\n`);

		const { incrementFileEditCount, resetFileEditCounts } = await import(
			"../state/session-state.ts"
		);
		resetFileEditCounts();
		// Simulate 4 prior edits (post-tool will add the 5th, reaching threshold of 5)
		for (let i = 0; i < 4; i++) incrementFileEditCount(file);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: file },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const { flushAll } = await import("../state/flush.ts");
		flushAll();
		resetAllCaches();
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "security-check-advisory")).toBe(true);
		expect(stderrCapture.join("")).toContain("Iterative security escalation");
	});
});

describe("postTool: test-quality blocking", () => {
	it("blocks empty test body on test file edit", async () => {
		const file = join(TEST_DIR, "empty.test.ts");
		writeFileSync(file, `import { it } from "vitest";\nit("does nothing", () => {});\n`);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: file },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const { flushAll } = await import("../state/flush.ts");
		flushAll();
		resetAllCaches();
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "test-quality-check")).toBe(true);
	});
});

describe("postTool: coverage gate on commit", () => {
	it("blocks commit when coverage is below threshold", async () => {
		// Set coverage threshold to 80%
		const { getDb, getProjectId } = await import("../state/db.ts");
		const db = getDb();
		const projectId = getProjectId();
		db.prepare(
			"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
		).run(projectId, "gates.coverage_threshold", JSON.stringify(80));

		// Set up a coverage gate that reports 75%
		saveGates({
			on_commit: {
				coverage: { command: "echo 'coverage: 75.0% of statements'", timeout: 5000 },
			},
		} as GatesConfig);
		resetAllCaches();

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test'" },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const { flushAll } = await import("../state/flush.ts");
		flushAll();
		resetAllCaches();
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "coverage")).toBe(true);
		expect(fixes.some((f) => f.errors.some((e) => e.includes("75")))).toBe(true);
	});

	it("does not block when coverage meets threshold", async () => {
		const { getDb, getProjectId } = await import("../state/db.ts");
		const db = getDb();
		const projectId = getProjectId();
		db.prepare(
			"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
		).run(projectId, "gates.coverage_threshold", JSON.stringify(80));

		saveGates({
			on_commit: {
				coverage: { command: "echo 'coverage: 85.0% of statements'", timeout: 5000 },
			},
		} as GatesConfig);
		resetAllCaches();

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test'" },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const { flushAll } = await import("../state/flush.ts");
		flushAll();
		resetAllCaches();
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "coverage")).toBe(false);
	});

	it("skips coverage check when threshold is 0 (default)", async () => {
		saveGates({
			on_commit: {
				coverage: { command: "echo 'coverage: 50.0% of statements'", timeout: 5000 },
			},
		} as GatesConfig);
		resetAllCaches();

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test'" },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const { flushAll } = await import("../state/flush.ts");
		flushAll();
		resetAllCaches();
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "coverage")).toBe(false);
	});
});

describe("postTool: dead-import escalation blocking", () => {
	it("promotes dead imports to blocking after threshold", async () => {
		const file = join(TEST_DIR, "unused.ts");
		writeFileSync(file, `import { foo } from "bar";\nconst x = 1;\n`);

		// Increment dead import count to threshold
		const { incrementEscalation } = await import("../state/session-state.ts");
		for (let i = 0; i < 5; i++) incrementEscalation("dead_import_warning_count");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: file },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const { flushAll } = await import("../state/flush.ts");
		flushAll();
		resetAllCaches();
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "dead-import-check")).toBe(true);
		expect(stderrCapture.join("")).toContain("Dead import escalation");
	});
});

describe("consumer typecheck", () => {
	it("consumer typecheck reruns on importers when enabled", async () => {
		// Enable consumer_typecheck via DB
		const db = getDb();
		const projectId = getProjectId();
		db.prepare(
			"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
		).run(projectId, "gates.consumer_typecheck", JSON.stringify(true));
		const { resetConfigCache } = await import("../config.ts");
		resetConfigCache();
		resetAllCaches();

		// Set up typecheck gate that always passes
		const gates: GatesConfig = {
			on_write: {
				typecheck: { command: "echo ok", run_once_per_batch: true },
			},
		};
		saveGates(gates);
		resetAllCaches();

		// Create importer that imports the target
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		const target = join(TEST_DIR, "src", "utils.ts");
		const consumer = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(consumer, 'import { foo } from "./utils";');

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			hook_event_name: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: target, new_string: "export const foo = 2;", old_string: "" },
			cwd: TEST_DIR,
		});

		// Verify no errors (typecheck passes for consumer)
		const { flushAll } = await import("../state/flush.ts");
		flushAll();
		resetAllCaches();

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		// Should not have pending fixes since typecheck passes
		expect(fixes.filter((f) => f.file === consumer)).toHaveLength(0);
	});
});

describe("classified diagnostics integration", () => {
	it("records classified diagnostics as pending fixes", async () => {
		// Set up a typecheck gate that outputs a tsc-style error
		const tscError = "src/foo.ts(10,5): error TS2339: Property 'bar' does not exist on type 'Foo'.";
		const gates: GatesConfig = {
			on_write: {
				typecheck: {
					command: `echo '${tscError}' >&2 && exit 1`,
					run_once_per_batch: true,
				},
			},
		};
		saveGates(gates);
		resetAllCaches();

		const file = join(TEST_DIR, "src", "foo.ts");
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(file, "const x: Foo = {}; x.bar;");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			hook_event_name: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: file, new_string: "x.bar", old_string: "" },
			cwd: TEST_DIR,
		});

		const { flushAll } = await import("../state/flush.ts");
		flushAll();
		resetAllCaches();

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		const typecheckFixes = fixes.filter((f) => f.gate === "typecheck");
		expect(typecheckFixes.length).toBeGreaterThanOrEqual(1);

		// Check that the error message contains the classified category prefix
		const hasClassified = typecheckFixes.some((f) =>
			f.errors.some((e) => e.includes("[hallucinated-api]")),
		);
		expect(hasClassified).toBe(true);
	});
});

describe("postTool: dataflow integration", () => {
	it("creates pending-fix with dataflow-check gate for tainted eval", async () => {
		saveGates({
			on_write: {
				lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
			},
		} as GatesConfig);
		resetAllCaches();

		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		const file = join(TEST_DIR, "src/tainted.ts");
		writeFileSync(file, "const x = req.body;\neval(x);\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: file },
		});

		const { readPendingFixes } = await import("../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		expect(fixes.some((f) => f.gate === "dataflow-check")).toBe(true);
		expect(fixes.some((f) => f.errors.some((e) => e.includes("eval")))).toBe(true);
	});
});

describe("postTool: complexity advisory", () => {
	it("writes complexity advisory to stderr for high-complexity function", async () => {
		saveGates({
			on_write: {
				lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
			},
		} as GatesConfig);
		resetAllCaches();

		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		const file = join(TEST_DIR, "src/complex.ts");
		// Generate a function with 20+ if statements for high cyclomatic complexity
		const ifs = Array.from({ length: 22 }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n");
		writeFileSync(file, `function complexFn(x: number): number {\n${ifs}\n  return -1;\n}\n`);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: file },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Complexity advisory");
		expect(stderr).toContain("complexFn");
	});
});
