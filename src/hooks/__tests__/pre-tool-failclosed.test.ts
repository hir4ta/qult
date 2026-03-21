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

describe("preToolUse — fail-closed on malformed _active.md", () => {
	it("denies Edit when _active.md exists but has no primary", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		// File exists but has no valid primary: field
		writeFileSync(join(specsDir, "_active.md"), "some garbage content\nno primary here");

		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		const out = getDenyOutput();
		expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
		expect(String(out?.hookSpecificOutput?.permissionDecisionReason)).toContain("Failed to read spec state");
	});

	it("denies Edit when _active.md has primary but no matching slug", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		// Has primary but tasks array doesn't match
		writeFileSync(join(specsDir, "_active.md"), "primary: ghost-task\ntasks:\n  - slug: other-task\n");

		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		const out = getDenyOutput();
		expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
	});

	it("allows Edit when no _active.md exists (no .alfred/specs/)", async () => {
		// No .alfred directory at all — emits allowTool with advisory (#19)
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		const out = JSON.parse(stdoutData[0] ?? "{}");
		expect(out?.hookSpecificOutput?.permissionDecision).toBe("allow");
	});

	it("allows Edit to .alfred/ paths even when _active.md is malformed", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(join(specsDir, "_active.md"), "broken content");

		// .alfred/ exempt check happens BEFORE fail-closed check
		await preToolUse(makeEvent("Edit", join(tmpDir, ".alfred/specs/test/design.md")));
		const out = getDenyOutput();
		expect(out?.hookSpecificOutput?.permissionDecision).toBe("allow");
	});

	it("allows Edit when _active.md has empty primary (all specs completed)", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(
			join(specsDir, "_active.md"),
			'primary: ""\ntasks:\n  - slug: old-task\n    status: done\n    started_at: 2026-03-19T10:00:00Z\n',
		);

		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		// Should NOT deny — empty primary is a valid state (no active spec)
		const out = getDenyOutput();
		const isDenied = out?.hookSpecificOutput?.permissionDecision === "deny";
		expect(isDenied).toBe(false);
	});

	it("allows Read even when _active.md is malformed (non-blockable)", async () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(join(specsDir, "_active.md"), "broken");

		await preToolUse(makeEvent("Read"));
		expect(stdoutData.length).toBe(0);
	});
});
