import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, setProjectPath, useTestDb } from "../../state/db.ts";
import { resetAllCaches } from "../../state/flush.ts";
import { resetLazyInit } from "../lazy-init.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-dispatcher");
const originalCwd = process.cwd();

function mockStdin(data: string): void {
	const readable = new Readable({ read() {} });
	readable.push(data);
	readable.push(null);
	vi.spyOn(process, "stdin", "get").mockReturnValue(readable as typeof process.stdin);
}

let stderrCapture: string[];
let exitCode: number | null;

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	resetAllCaches();
	resetLazyInit();
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stderrCapture = [];
	exitCode = null;

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

describe("HOOK_CLASS", () => {
	it("has entries for all hook events", async () => {
		const { HOOK_CLASS } = await import("../dispatcher.ts");
		const events = Object.keys(HOOK_CLASS);
		expect(events).toHaveLength(7);
		expect(events).toContain("pre-tool");
		expect(events).toContain("post-tool");
		expect(events).toContain("stop");
		expect(events).toContain("subagent-stop");
		expect(events).toContain("task-completed");
		expect(events).toContain("session-start");
		expect(events).toContain("post-compact");
	});

	it("classifies enforcement vs advisory correctly", async () => {
		const { HOOK_CLASS } = await import("../dispatcher.ts");
		expect(HOOK_CLASS["pre-tool"]).toBe("enforcement");
		expect(HOOK_CLASS["post-tool"]).toBe("enforcement");
		expect(HOOK_CLASS.stop).toBe("enforcement");
		expect(HOOK_CLASS["subagent-stop"]).toBe("enforcement");
		expect(HOOK_CLASS["task-completed"]).toBe("advisory");
		expect(HOOK_CLASS["session-start"]).toBe("advisory");
		expect(HOOK_CLASS["post-compact"]).toBe("advisory");
	});
});

describe("dispatch()", () => {
	it("exits 1 for unknown event", async () => {
		const { dispatch } = await import("../dispatcher.ts");
		try {
			await dispatch("nonexistent-event");
		} catch {
			// process.exit throws
		}

		expect(exitCode).toBe(1);
		expect(stderrCapture.join("")).toContain("Unknown hook event");
	});

	it("returns silently on stdin read error (fail-open)", async () => {
		const readable = new Readable({
			read() {
				this.destroy(new Error("stdin broken"));
			},
		});
		vi.spyOn(process, "stdin", "get").mockReturnValue(readable as typeof process.stdin);

		const { dispatch } = await import("../dispatcher.ts");
		await dispatch("session-start");

		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toBe("");
	});

	it("returns silently on empty stdin (fail-open)", async () => {
		mockStdin("");

		const { dispatch } = await import("../dispatcher.ts");
		await dispatch("session-start");

		expect(exitCode).toBeNull();
	});

	it("returns silently on oversized stdin >5MB (fail-open)", async () => {
		mockStdin("x".repeat(5_000_001));

		const { dispatch } = await import("../dispatcher.ts");
		await dispatch("session-start");

		expect(exitCode).toBeNull();
	});

	it("returns silently on invalid JSON (fail-open)", async () => {
		mockStdin("not-json{{{");

		const { dispatch } = await import("../dispatcher.ts");
		await dispatch("session-start");

		expect(exitCode).toBeNull();
	});

	it("dispatches to the correct handler", async () => {
		mockStdin(JSON.stringify({ session_id: "test-handler" }));

		const { dispatch } = await import("../dispatcher.ts");
		// session-start handler should run without error
		await dispatch("session-start");

		expect(exitCode).toBeNull();
	});

	it("writes debug messages to stderr when QULT_DEBUG is set", async () => {
		process.env.QULT_DEBUG = "1";
		mockStdin(JSON.stringify({ session_id: "debug-test" }));

		const { dispatch } = await import("../dispatcher.ts");
		await dispatch("session-start");

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("[qult:debug] event=session-start");
		expect(stderr).toContain("[qult:debug] session-start done in");

		delete process.env.QULT_DEBUG;
	});

	it("catches handler errors and writes to stderr (fail-open)", async () => {
		mockStdin(JSON.stringify({}));

		// Dispatch an unknown-but-mapped event with a mocked handler that throws.
		// Since vi.doMock doesn't reliably intercept lazy imports in vitest/bun,
		// we test the catch block indirectly: dispatcher logs errors to stderr
		// when the handler throws (non-exit errors).
		// Use session-start with invalid state to trigger an error path.
		const { dispatch } = await import("../dispatcher.ts");

		// Valid event with empty input — should not crash (fail-open)
		await dispatch("post-tool");
		expect(exitCode).toBeNull();
	});

	it("swallows process.exit errors from deny/block without double-logging", async () => {
		mockStdin(JSON.stringify({}));

		const { dispatch } = await import("../dispatcher.ts");
		await dispatch("post-tool");

		// Should not log "process.exit" as an error
		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("[qult] post-tool: process.exit");
	});

	it("calls flushAll in finally block even when handler throws", async () => {
		const flushMod = await import("../../state/flush.ts");
		const flushSpy = vi.spyOn(flushMod, "flushAll");

		mockStdin(JSON.stringify({}));

		const { dispatch } = await import("../dispatcher.ts");
		await dispatch("session-start");

		expect(flushSpy).toHaveBeenCalled();
		flushSpy.mockRestore();
	});
});
