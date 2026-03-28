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

function getResponse(): Record<string, unknown> | null {
	const output = stdoutCapture.join("");
	if (!output) return null;
	return JSON.parse(output);
}

describe("respond()", () => {
	it("writes additionalContext to stdout", async () => {
		const { respond } = await import("../respond.ts");
		respond("Fix this error");
		const response = getResponse();
		expect(response).not.toBeNull();
		expect((response?.hookSpecificOutput as Record<string, string>)?.additionalContext).toBe(
			"Fix this error",
		);
	});
});

describe("deny()", () => {
	it("writes permissionDecision deny and exits with code 2", async () => {
		const { deny } = await import("../respond.ts");
		try {
			deny("Fix errors first");
		} catch {
			// process.exit(2) throws
		}
		expect(exitCode).toBe(2);
		const response = getResponse();
		expect((response?.hookSpecificOutput as Record<string, string>)?.permissionDecision).toBe(
			"deny",
		);
		expect(stderrCapture.join("")).toContain("Fix errors first");
	});
});

describe("block()", () => {
	it("writes top-level decision/reason and exits with code 2", async () => {
		const { block } = await import("../respond.ts");
		try {
			block("Pending fixes remain");
		} catch {
			// process.exit(2) throws
		}
		expect(exitCode).toBe(2);
		const response = getResponse();
		expect(response?.decision).toBe("block");
		expect(response?.reason).toBe("Pending fixes remain");
	});
});
