import { mkdirSync, rmSync } from "node:fs";
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
