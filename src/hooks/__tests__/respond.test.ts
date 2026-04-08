import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeDb,
	ensureSession,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../../state/db.ts";
import { resetAllCaches } from "../../state/flush.ts";
import { writePendingFixes } from "../../state/pending-fixes.ts";
import { disableGate, recordChangedFile, recordTestPass } from "../../state/session-state.ts";

const TEST_DIR = "/tmp/.tmp-respond-test";

let stdoutCapture: string[] = [];
let stderrCapture: string[] = [];
let exitCode: number | null = null;

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	resetAllCaches();
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
	closeDb();
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
		writePendingFixes([{ file: "a.ts", errors: ["error"], gate: "lint" }]);
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
		recordTestPass("vitest");
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		expect(summary).toContain("tests: PASS");
	});

	it("includes changed file count", async () => {
		recordChangedFile("a.ts");
		recordChangedFile("b.ts");
		recordChangedFile("c.ts");
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		expect(summary).toContain("3 file(s) changed");
	});

	it("includes disabled gates", async () => {
		disableGate("lint");
		disableGate("review");
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		expect(summary).toContain("disabled: lint,review");
	});

	it("returns empty string on error (fail-open)", async () => {
		closeDb();
		const { compactStateSummary } = await import("../respond.ts");
		const summary = compactStateSummary();
		// Should not throw, returns empty or valid summary
		expect(typeof summary).toBe("string");
	});
});
