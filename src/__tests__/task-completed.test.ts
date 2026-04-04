import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";

const TEST_DIR = join(import.meta.dirname, ".tmp-task-completed-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
let stderrCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

function writePlan(content: string): void {
	const planDir = join(TEST_DIR, ".claude", "plans");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(join(planDir, "test-plan.md"), content);
}

function writeGates(config: Record<string, unknown>): void {
	writeFileSync(join(TEST_DIR, ".qult", "gates.json"), JSON.stringify(config));
}

function makePlanContent(opts: {
	taskNumber?: number;
	taskName?: string;
	status?: string;
	verify?: string;
}): string {
	const num = opts.taskNumber ?? 1;
	const name = opts.taskName ?? "Add feature";
	const status = opts.status ?? "pending";
	const lines = ["## Tasks", `### Task ${num}: ${name} [${status}]`, `- **File**: src/foo.ts`];
	if (opts.verify) {
		lines.push(`- **Verify**: ${opts.verify}`);
	}
	return lines.join("\n");
}

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stderrCapture = [];
	exitCode = null;
	vi.mocked(spawnSync).mockReset();

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
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

async function loadTaskCompleted() {
	return (await import("../hooks/task-completed.ts")).default;
}

describe("taskCompleted: no-op conditions (fail-open)", () => {
	it("returns without action when no task_subject", async () => {
		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({});

		expect(exitCode).toBeNull();
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("returns without action when no active plan", async () => {
		const taskCompleted = await loadTaskCompleted();
		// No .claude/plans/ directory exists
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("returns without action when task subject doesn't match any plan task", async () => {
		writePlan(
			makePlanContent({ taskName: "Add feature", verify: "src/__tests__/foo.test.ts:testFoo" }),
		);
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Nonexistent task" });

		expect(exitCode).toBeNull();
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("returns without action when task has no Verify field", async () => {
		writePlan(makePlanContent({ taskName: "Add feature" }));
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).not.toHaveBeenCalled();
	});
});

describe("taskCompleted: task matching", () => {
	it("matches task by number (Task N: name)", async () => {
		writePlan(
			makePlanContent({
				taskNumber: 3,
				taskName: "Build widget",
				verify: "src/__tests__/widget.test.ts:testWidget",
			}),
		);
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 3: Build widget" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledOnce();
	});

	it("matches task by exact name", async () => {
		writePlan(
			makePlanContent({ taskName: "Add feature", verify: "src/__tests__/feat.test.ts:testFeat" }),
		);
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledOnce();
	});
});

describe("taskCompleted: shell safety", () => {
	it("skips execution for unsafe shell arg in file path", async () => {
		writePlan(makePlanContent({ verify: "foo;rm -rf /:testFoo" }));
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("skips execution for unsafe shell arg in test name", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:test$(evil)" }));
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("allows safe shell args through", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:testFoo" }));
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledOnce();
	});
});

describe("taskCompleted: test runner detection", () => {
	it("builds vitest command", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:testFoo" }));
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledWith(
			"vitest",
			["run", "src/__tests__/foo.test.ts", "-t", "testFoo"],
			expect.anything(),
		);
	});

	it("builds jest command", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:testFoo" }));
		writeGates({ on_commit: { test: { command: "jest --coverage", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledWith(
			"jest",
			["src/__tests__/foo.test.ts", "-t", "testFoo"],
			expect.anything(),
		);
	});

	it("builds pytest command", async () => {
		writePlan(makePlanContent({ verify: "tests/test_foo.py:test_bar" }));
		writeGates({ on_commit: { test: { command: "pytest tests/", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledWith(
			"pytest",
			["tests/test_foo.py", "-k", "test_bar"],
			expect.anything(),
		);
	});

	it("builds go test command", async () => {
		writePlan(makePlanContent({ verify: "pkg/foo:TestBar" }));
		writeGates({ on_commit: { test: { command: "go test ./...", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledWith("go", ["test", "./pkg/foo"], expect.anything());
	});

	it("builds cargo test command", async () => {
		writePlan(makePlanContent({ verify: "src/lib.rs:test_bar" }));
		writeGates({ on_commit: { test: { command: "cargo test", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledWith("cargo", ["test", "test_bar"], expect.anything());
	});

	it("returns without action when no on_commit gates", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:testFoo" }));
		writeGates({ on_write: { lint: { command: "biome check", timeout: 5000 } } });

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("returns without action when no gates file exists", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:testFoo" }));

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).not.toHaveBeenCalled();
	});
});

describe("taskCompleted: execution (fail-open)", () => {
	it("succeeds silently when test passes", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:testFoo" }));
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });
		vi.mocked(spawnSync).mockReturnValue({
			status: 0,
			stdout: "",
			stderr: "",
			pid: 0,
			output: [],
			signal: null,
		});

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledOnce();
	});

	it("does not block when test fails (fail-open)", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:testFoo" }));
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });
		vi.mocked(spawnSync).mockImplementation(() => {
			throw new Error("test failed");
		});

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		expect(exitCode).toBeNull();
		expect(spawnSync).toHaveBeenCalledOnce();
	});
});

describe("taskCompleted: recordsVerifyResult", () => {
	it("records verify test pass result in session state", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:testFoo" }));
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });
		vi.mocked(spawnSync).mockReturnValue({
			status: 0,
			stdout: "",
			stderr: "",
			pid: 0,
			output: [],
			signal: null,
		});

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		const { readTaskVerifyResult } = await import("../state/session-state.ts");
		const result = readTaskVerifyResult("Task 1");
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
		expect(result!.ran_at).toBeTruthy();
	});

	it("records verify test fail result in session state", async () => {
		writePlan(makePlanContent({ verify: "src/__tests__/foo.test.ts:testFoo" }));
		writeGates({ on_commit: { test: { command: "vitest run", timeout: 5000 } } });
		vi.mocked(spawnSync).mockReturnValue({
			status: 1,
			stdout: "",
			stderr: "Test failed",
			pid: 0,
			output: [],
			signal: null,
		});

		const taskCompleted = await loadTaskCompleted();
		await taskCompleted({ task_subject: "Task 1: Add feature" });

		const { readTaskVerifyResult } = await import("../state/session-state.ts");
		const result = readTaskVerifyResult("Task 1");
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});
});
