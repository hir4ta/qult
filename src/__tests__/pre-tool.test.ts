import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveGates } from "../gates/load.ts";
import {
	closeDb,
	ensureSession,
	getDb,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";
import type { GatesConfig } from "../types.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-pretool-test");
let stderrCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	resetAllCaches();
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stderrCapture = [];
	exitCode = null;

	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
	closeDb();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("preTool: Edit/Write checks", () => {
	it("DENY editing other files when pending-fixes exist", async () => {
		const { writePendingFixes } = await import("../state/pending-fixes.ts");
		writePendingFixes([
			{
				file: join(TEST_DIR, "src/broken.ts"),
				errors: ["type error"],
				gate: "typecheck",
			},
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
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("Fix existing errors");
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
		saveGates({
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile("/fake/src/file.ts");

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
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("test");
	});

	it("allows commit without review for small change", async () => {
		saveGates({
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

		const { recordTestPass } = await import("../state/session-state.ts");
		recordTestPass("vitest run");

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "test"' },
		});

		expect(exitCode).toBeNull();
	});

	it("DENY commit without review when plan is active and no gates.json", async () => {
		// No gates.json — review enforcement should still work
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: test [pending]\n- **File**: foo.ts\n",
		);

		const { recordChangedFile } = await import("../state/session-state.ts");
		for (let i = 0; i < 5; i++) recordChangedFile(`/fake/changed-file${i}.ts`);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Bash",
				tool_input: { command: 'git commit -m "no gates"' },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("review");
	});

	it("DENY commit without review when plan is active", async () => {
		saveGates({
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: test [pending]\n- **File**: foo.ts\n",
		);

		const { recordChangedFile, recordTestPass } = await import("../state/session-state.ts");
		for (let i = 0; i < 5; i++) recordChangedFile(`/fake/changed-file${i}.ts`);
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
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("review");
	});

	it("DENY commit without review when many files changed", async () => {
		saveGates({
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

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
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("review");
	});

	it("allows commit when review is disabled via disable_gate", async () => {
		saveGates({
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

		// Plan required for 6+ files
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "test-plan.md"), "## Tasks\n### Task 1: test [done]\n");

		const { disableGate, recordChangedFile, recordFinishStarted, recordTestPass } = await import(
			"../state/session-state.ts"
		);
		recordTestPass("vitest run");
		recordFinishStarted(); // finish gate unlock
		for (let i = 0; i < 6; i++) {
			recordChangedFile(`/project/src/file${i}.ts`);
		}
		disableGate("review");

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "large change"' },
		});

		expect(exitCode).toBeNull();
	});

	it("advisory warning when plan missing but many files changed", async () => {
		saveGates({
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

		const { recordChangedFile, recordTestPass, recordReview } = await import(
			"../state/session-state.ts"
		);
		recordTestPass("vitest run");
		recordReview(); // review recorded — but no plan
		for (let i = 0; i < 6; i++) {
			recordChangedFile(`/project/src/file${i}.ts`);
		}
		// No plan directory created

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "bypass attempt"' },
		});

		expect(exitCode).toBeNull(); // advisory, not deny
		expect(stderrCapture.join("")).toContain("Advisory");
	});

	it("allows commit when plan exists with many changed files", async () => {
		saveGates({
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

		const { recordChangedFile, recordFinishStarted, recordTestPass, recordReview } = await import(
			"../state/session-state.ts"
		);
		recordTestPass("vitest run");
		recordReview();
		recordFinishStarted(); // finish gate unlock
		for (let i = 0; i < 6; i++) {
			recordChangedFile(`/project/src/file${i}.ts`);
		}

		// Create a plan
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "test-plan.md"), "## Tasks\n### Task 1: test [done]\n");

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "planned change"' },
		});

		expect(exitCode).toBeNull();
	});

	it("allows non-commit Bash commands", async () => {
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: "ls -la" },
		});

		expect(exitCode).toBeNull();
	});

	it("DENY git -c key=value commit (config args before commit)", async () => {
		saveGates({
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile("/fake/src/file.ts");

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Bash",
				tool_input: { command: 'git -c user.name="Foo" commit -m "msg"' },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
	});

	it("DENY case-insensitive GIT COMMIT", async () => {
		saveGates({
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		} as GatesConfig);
		resetAllCaches();

		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile("/fake/src/file.ts");

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Bash",
				tool_input: { command: 'GIT COMMIT -m "msg"' },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
	});
});

describe("preTool: TDD enforcement", () => {
	function setupPlanWithVerify(): void {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- **File**: src/helper.ts",
				"- **Verify**: src/__tests__/helper.test.ts:testHelper",
			].join("\n"),
		);
	}

	it("DENY impl edit when test not yet edited", async () => {
		setupPlanWithVerify();

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/helper.ts") },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("TDD");
		expect(errOutput).toContain("src/__tests__/helper.test.ts");
	});

	it("allows impl edit after test file edited", async () => {
		setupPlanWithVerify();

		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile(join(TEST_DIR, "src/__tests__/helper.test.ts"));

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/helper.ts") },
		});

		expect(exitCode).toBeNull();
	});

	it("allows editing test file itself", async () => {
		setupPlanWithVerify();

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/__tests__/helper.test.ts") },
		});

		expect(exitCode).toBeNull();
	});

	it("no plan — no TDD enforcement", async () => {
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/helper.ts") },
		});

		expect(exitCode).toBeNull();
	});

	it("task without Verify — no TDD enforcement", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			["## Tasks", "### Task 1: Add helper [pending]", "- **File**: src/helper.ts"].join("\n"),
		);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/helper.ts") },
		});

		expect(exitCode).toBeNull();
	});
});

describe("preTool: tddRedVerification", () => {
	function setupPlanWithVerify(): void {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add feature [pending]",
				"- **File**: src/feature.ts",
				"- **Verify**: src/__tests__/feature.test.ts:testFeature",
			].join("\n"),
		);
	}

	it("denies impl edit when verify test already passes (RED violation)", async () => {
		setupPlanWithVerify();

		const { recordChangedFile, recordTaskVerifyResult } = await import("../state/session-state.ts");
		// Test file was edited
		recordChangedFile(join(TEST_DIR, "src/__tests__/feature.test.ts"));
		// But verify test passed (no RED state)
		recordTaskVerifyResult("Task 1", true);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/feature.ts") },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("TDD");
		expect(errOutput).toContain("already passes");
		expect(errOutput).toContain("RED");
	});

	it("allows impl edit when verify test fails (RED confirmed)", async () => {
		setupPlanWithVerify();

		const { recordChangedFile, recordTaskVerifyResult } = await import("../state/session-state.ts");
		recordChangedFile(join(TEST_DIR, "src/__tests__/feature.test.ts"));
		// Verify test failed (RED state confirmed)
		recordTaskVerifyResult("Task 1", false);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/feature.ts") },
		});

		expect(exitCode).toBeNull();
	});

	it("allows impl edit when no verify result yet (fail-open)", async () => {
		setupPlanWithVerify();

		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile(join(TEST_DIR, "src/__tests__/feature.test.ts"));
		// No recordTaskVerifyResult call — result not yet available

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/feature.ts") },
		});

		expect(exitCode).toBeNull();
	});
});

describe("preTool: task drift detection", () => {
	function setupPlanWithFiles(): void {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add feature [pending]",
				"- **File**: src/feature.ts",
				"### Task 2: Add helper [pending]",
				"- **File**: src/helper.ts",
			].join("\n"),
		);
	}

	it("warns when editing a file not in plan scope", async () => {
		setupPlanWithFiles();

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/unrelated.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Task drift");
		expect(exitCode).toBeNull(); // No DENY
	});

	it("does not warn when editing a file in plan scope", async () => {
		setupPlanWithFiles();

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/feature.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("Task drift");
	});

	it("does not warn when no plan is active", async () => {
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/random.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("Task drift");
	});

	it("does not call deny even when drift detected", async () => {
		setupPlanWithFiles();

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/unrelated.ts") },
		});

		expect(exitCode).toBeNull();
	});
});

describe("preTool: ExitPlanMode selfcheck gate", () => {
	it("DENY first ExitPlanMode to force selfcheck", async () => {
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({ tool_name: "ExitPlanMode" });
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("omissions");
		expect(errOutput).toContain("ExitPlanMode again");
	});

	it("allows second ExitPlanMode after selfcheck blocked", async () => {
		const { recordPlanSelfcheckBlocked } = await import("../state/session-state.ts");
		recordPlanSelfcheckBlocked();

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({ tool_name: "ExitPlanMode" });

		expect(exitCode).toBeNull();
	});
});

describe("preTool: EnterPlanMode redirect to plan-generator", () => {
	it("DENY EnterPlanMode and redirect to /qult:plan-generator", async () => {
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({ tool_name: "EnterPlanMode" });
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("plan-generator");
	});
});

describe("preTool: git commit with active plan requires /qult:finish", () => {
	it("DENY git commit when plan active and finish not started", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"### Task 1: Test [done]\n- **File**: src/foo.ts\n",
		);

		const db = getDb();
		db.prepare("INSERT INTO changed_files (session_id, file_path) VALUES (?, ?)").run(
			"test-session",
			join(TEST_DIR, "src/foo.ts"),
		);
		db.prepare("UPDATE sessions SET test_passed_at = ?, review_completed_at = ? WHERE id = ?").run(
			new Date().toISOString(),
			new Date().toISOString(),
			"test-session",
		);
		resetAllCaches();

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'test'" },
			});
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("qult:finish");
	});

	it("allows git commit when finish was started", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"### Task 1: Test [done]\n- **File**: src/foo.ts\n",
		);

		const db = getDb();
		db.prepare("INSERT INTO changed_files (session_id, file_path) VALUES (?, ?)").run(
			"test-session",
			join(TEST_DIR, "src/foo.ts"),
		);
		db.prepare("UPDATE sessions SET test_passed_at = ?, review_completed_at = ? WHERE id = ?").run(
			new Date().toISOString(),
			new Date().toISOString(),
			"test-session",
		);
		// Record finish started
		db.prepare("INSERT INTO ran_gates (session_id, gate_name) VALUES (?, ?)").run(
			"test-session",
			"__finish_started__",
		);
		resetAllCaches();

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test'" },
		});

		expect(exitCode).toBeNull();
	});
});

describe("preTool: TaskCreate promotion", () => {
	it("warns when editing a plan task file for the first time", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			["## Tasks", "### Task 1: Add widget [pending]", "- **File**: src/widget.ts"].join("\n"),
		);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/widget.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Plan task detected");
		expect(stderr).toContain("TaskCreate");
	});

	it("does not warn on second edit of same file", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			["## Tasks", "### Task 1: Add widget [pending]", "- **File**: src/widget.ts"].join("\n"),
		);

		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile(join(TEST_DIR, "src/widget.ts"));

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/widget.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("Plan task detected");
	});

	it("does not warn when no plan exists", async () => {
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/random.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("Plan task detected");
	});
});
