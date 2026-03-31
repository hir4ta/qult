import { describe, expect, it, vi } from "vitest";
import { HOOK_CLASS } from "../dispatcher.ts";

describe("HOOK_CLASS", () => {
	it("has entries for all hook events", () => {
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

	it("classifies enforcement vs advisory correctly", () => {
		expect(HOOK_CLASS["pre-tool"]).toBe("enforcement");
		expect(HOOK_CLASS["post-tool"]).toBe("enforcement");
		expect(HOOK_CLASS.stop).toBe("enforcement");
		expect(HOOK_CLASS["subagent-stop"]).toBe("enforcement");
		expect(HOOK_CLASS["task-completed"]).toBe("advisory");
	});
});

describe("dispatch()", () => {
	it("exits 1 for unknown event", async () => {
		let exitCode: number | null = null;
		const stderrCapture: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((data) => {
			stderrCapture.push(typeof data === "string" ? data : data.toString());
			return true;
		});
		vi.spyOn(process, "exit").mockImplementation((code) => {
			exitCode = code as number;
			throw new Error(`process.exit(${code})`);
		});

		const { dispatch } = await import("../dispatcher.ts");
		try {
			await dispatch("nonexistent-event");
		} catch {
			// process.exit throws
		}

		expect(exitCode).toBe(1);
		expect(stderrCapture.join("")).toContain("Unknown hook event");
		vi.restoreAllMocks();
	});
});
