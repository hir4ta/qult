import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-status");
const QULT_DIR = join(TEST_DIR, ".qult");
const STATE_DIR = join(QULT_DIR, ".state");

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
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

function getOutput(): string {
	return stdoutCapture.join("");
}

describe("qult status", () => {
	it("shows clean state when no blockers", async () => {
		writeFileSync(
			join(QULT_DIR, "gates.json"),
			JSON.stringify({ on_write: { lint: { command: "biome check {file}", timeout: 3000 } } }),
		);
		const { runStatus } = await import("../status.ts");
		runStatus();
		const output = getOutput();
		expect(output).toContain("Pending fixes");
		expect(output).toContain("0");
	});

	it("shows pending fixes as blockers", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));
		writeFileSync(
			join(STATE_DIR, "pending-fixes.json"),
			JSON.stringify([{ file: "src/foo.ts", errors: ["unused import"], gate: "lint" }]),
		);
		const { runStatus } = await import("../status.ts");
		runStatus();
		const output = getOutput();
		expect(output).toContain("src/foo.ts");
		expect(output).toContain("lint");
	});

	it("shows review status", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));
		const { runStatus } = await import("../status.ts");
		runStatus();
		const output = getOutput();
		expect(output).toContain("Review");
		expect(output).toContain("Test gate");
	});

	it("shows plan progress when plan exists", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: Add feature [done]\n### Task 2: Add tests [pending]\n### Task 3: Update docs [in-progress]\n",
		);
		const { runStatus } = await import("../status.ts");
		runStatus();
		const output = getOutput();
		expect(output).toContain("1/3");
		expect(output).toContain("Plan");
	});
});
