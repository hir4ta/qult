import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-respond");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");

let stdoutCapture: string[] = [];
let stderrCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
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

describe("setCurrentEvent / getCurrentEvent", () => {
	it("stores and retrieves the current hook event name", async () => {
		const { setCurrentEvent, getCurrentEvent } = await import("../respond.ts");
		expect(getCurrentEvent()).toBe("unknown");
		setCurrentEvent("pre-tool");
		expect(getCurrentEvent()).toBe("pre-tool");
		setCurrentEvent("unknown");
	});
});

describe("deny()", () => {
	it("exits with code 2 and writes reason to stderr only", async () => {
		const { deny } = await import("../respond.ts");
		try {
			deny("Fix errors first");
		} catch {
			// process.exit(2) throws
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Fix errors first");
		expect(stdoutCapture.join("")).toBe("");
	});

	it("appends compact state summary to stderr", async () => {
		const { deny } = await import("../respond.ts");
		try {
			deny("Fix errors first");
		} catch {
			// process.exit(2) throws
		}
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("[qult state]");
		expect(stderr).toContain("tests: NOT PASSED");
		expect(stderr).toContain("review: NOT DONE");
	});
});

describe("deny() fail-open", () => {
	it("still exits 2 even when flushAll throws", async () => {
		const flushMod = await import("../../state/flush.ts");
		vi.spyOn(flushMod, "flushAll").mockImplementation(() => {
			throw new Error("flush boom");
		});

		const { deny } = await import("../respond.ts");
		try {
			deny("Deny with broken flush");
		} catch {
			// process.exit(2) throws
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Deny with broken flush");
	});
});

describe("block()", () => {
	it("exits with code 2 and writes reason to stderr only", async () => {
		const { block } = await import("../respond.ts");
		try {
			block("Pending fixes remain");
		} catch {
			// process.exit(2) throws
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Pending fixes remain");
		expect(stdoutCapture.join("")).toBe("");
	});

	it("appends compact state summary to stderr", async () => {
		const { block } = await import("../respond.ts");
		try {
			block("Pending fixes remain");
		} catch {
			// process.exit(2) throws
		}
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("[qult state]");
		expect(stderr).toContain("tests: NOT PASSED");
	});
});

describe("block() fail-open", () => {
	it("still exits 2 even when flushAll throws", async () => {
		const flushMod = await import("../../state/flush.ts");
		vi.spyOn(flushMod, "flushAll").mockImplementation(() => {
			throw new Error("flush boom");
		});

		const { block } = await import("../respond.ts");
		try {
			block("Block with broken flush");
		} catch {
			// process.exit(2) throws
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Block with broken flush");
	});
});

describe("compactStateSummary()", () => {
	it("includes pending fixes count when fixes exist", async () => {
		writeFileSync(
			join(STATE_DIR, "pending-fixes.json"),
			JSON.stringify([{ file: "a.ts", errors: ["error"], gate: "lint" }]),
		);
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		expect(summary).toContain("1 pending fix(es)");
	});

	it("includes test and review status", async () => {
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		expect(summary).toContain("tests: NOT PASSED");
		expect(summary).toContain("review: NOT DONE");
	});

	it("shows PASS when tests passed", async () => {
		writeFileSync(
			join(STATE_DIR, "session-state.json"),
			JSON.stringify({ test_passed_at: "2024-01-01T00:00:00Z", test_command: "vitest" }),
		);
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		expect(summary).toContain("tests: PASS");
	});

	it("includes changed file count", async () => {
		writeFileSync(
			join(STATE_DIR, "session-state.json"),
			JSON.stringify({ changed_file_paths: ["a.ts", "b.ts", "c.ts"] }),
		);
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		expect(summary).toContain("3 file(s) changed");
	});

	it("includes disabled gates", async () => {
		writeFileSync(
			join(STATE_DIR, "session-state.json"),
			JSON.stringify({ disabled_gates: ["lint", "review"] }),
		);
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		expect(summary).toContain("disabled: lint,review");
	});

	it("returns empty string on error (fail-open)", async () => {
		// Remove state dir to trigger error
		rmSync(TEST_DIR, { recursive: true, force: true });
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		// Should not throw, returns empty or valid summary
		expect(typeof summary).toBe("string");
	});
});
