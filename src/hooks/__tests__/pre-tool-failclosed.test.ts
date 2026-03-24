import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookEvent } from "../dispatcher.js";
import { preToolUse } from "../pre-tool.js";

let tmpDir: string;
let stdoutData: string[];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pre-tool-fc-"));
	stdoutData = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutData.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function makeEvent(toolName: string, filePath?: string): HookEvent {
	return {
		cwd: tmpDir,
		tool_name: toolName,
		tool_input: filePath ? { file_path: filePath } : {},
	};
}

function getDenyOutput(): { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null {
	for (const line of stdoutData) {
		try {
			return JSON.parse(line.trim());
		} catch {}
	}
	return null;
}

describe("preToolUse — fail-closed on malformed _active.json", () => {
	it("denies Edit when _active.json exists but has corrupt JSON", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(join(specsDir, "_active.json"), "some garbage content\nno json here");

		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		const out = getDenyOutput();
		expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
		expect(String(out?.hookSpecificOutput?.permissionDecisionReason)).toContain("Failed to read spec state");
	});

	it("denies Edit when _active.json has primary but no matching slug", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		const state = { primary: "ghost-task", tasks: [{ slug: "other-task", started_at: "2026-01-01T00:00:00Z" }] };
		writeFileSync(join(specsDir, "_active.json"), JSON.stringify(state));

		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		const out = getDenyOutput();
		expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
	});

	it("allows Edit when no _active.json exists (no .alfred/specs/)", async () => {
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		const out = JSON.parse(stdoutData[0] ?? "{}");
		expect(out?.hookSpecificOutput?.permissionDecision).toBe("allow");
	});

	it("allows Edit to .alfred/ paths even when _active.json is malformed", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(join(specsDir, "_active.json"), "broken content");

		await preToolUse(makeEvent("Edit", join(tmpDir, ".alfred/specs/test/design.md")));
		const out = getDenyOutput();
		expect(out?.hookSpecificOutput?.permissionDecision).toBe("allow");
	});

	it("allows Edit when _active.json has empty primary (all specs completed)", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		const state = { primary: "", tasks: [{ slug: "old-task", status: "done", started_at: "2026-03-19T10:00:00Z" }] };
		writeFileSync(join(specsDir, "_active.json"), JSON.stringify(state));

		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		const out = getDenyOutput();
		const isDenied = out?.hookSpecificOutput?.permissionDecision === "deny";
		expect(isDenied).toBe(false);
	});

	it("allows Read even when _active.json is malformed (non-blockable)", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(join(specsDir, "_active.json"), "broken");

		await preToolUse(makeEvent("Read"));
		expect(stdoutData.length).toBe(0);
	});
});
