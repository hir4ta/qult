import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookEvent } from "../dispatcher.js";
import { preToolUse } from "../pre-tool.js";
import { writeReviewGate } from "../review-gate.js";

let tmpDir: string;
let stdoutData: string[];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pre-tool-"));
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

function setupSpec(opts: { size?: string; reviewStatus?: string; status?: string }): void {
	const specsDir = join(tmpDir, ".alfred", "specs");
	mkdirSync(specsDir, { recursive: true });
	let yaml = `primary: test-task\ntasks:\n  - slug: test-task\n    started_at: 2026-01-01T00:00:00Z\n`;
	if (opts.size) yaml += `    size: ${opts.size}\n`;
	if (opts.reviewStatus) yaml += `    review_status: ${opts.reviewStatus}\n`;
	if (opts.status) yaml += `    status: ${opts.status}\n`;
	writeFileSync(join(specsDir, "_active.md"), yaml);
}

function makeEvent(toolName: string, filePath?: string): HookEvent {
	return {
		cwd: tmpDir,
		tool_name: toolName,
		tool_input: filePath ? { file_path: filePath } : {},
	};
}

function getOutput(): { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null {
	for (const line of stdoutData) {
		try {
			return JSON.parse(line.trim());
		} catch {}
	}
	return null;
}

function getDecision(): string | undefined {
	return getOutput()?.hookSpecificOutput?.permissionDecision;
}

describe("preToolUse", () => {
	it("denies Edit on M unapproved spec", async () => {
		setupSpec({ size: "M", reviewStatus: "pending" });
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		expect(getDecision()).toBe("deny");
	});

	it("denies Write on L unapproved spec", async () => {
		setupSpec({ size: "L", reviewStatus: "pending" });
		await preToolUse(makeEvent("Write", join(tmpDir, "src/new.ts")));
		expect(getDecision()).toBe("deny");
	});

	it("allows Edit on M approved spec (skips prompt hook)", async () => {
		setupSpec({ size: "M", reviewStatus: "approved" });
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		expect(getDecision()).toBe("allow");
	});

	it("allows Edit on S spec regardless of review status (skips prompt hook)", async () => {
		setupSpec({ size: "S" });
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		expect(getDecision()).toBe("allow");
	});

	it("allows Edit on D spec regardless of review status (skips prompt hook)", async () => {
		setupSpec({ size: "D" });
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		expect(getDecision()).toBe("allow");
	});

	it("allows Edit to .alfred/ paths (spec exempt)", async () => {
		setupSpec({ size: "M", reviewStatus: "pending" });
		await preToolUse(makeEvent("Edit", join(tmpDir, ".alfred/specs/test-task/design.md")));
		expect(getDecision()).toBe("allow");
	});

	it("allows Edit with advisory when no active spec (#19: prompt hook removed)", async () => {
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		// Now emits allowTool() with advisory — prompt hook no longer exists
		expect(getDecision()).toBe("allow");
	});

	it("allows non-blockable tools (Read)", async () => {
		setupSpec({ size: "M", reviewStatus: "pending" });
		await preToolUse(makeEvent("Read"));
		expect(stdoutData.length).toBe(0);
	});

	it("allows non-blockable tools (Bash)", async () => {
		setupSpec({ size: "M", reviewStatus: "pending" });
		await preToolUse(makeEvent("Bash"));
		expect(stdoutData.length).toBe(0);
	});

	it("denies XL unapproved spec", async () => {
		setupSpec({ size: "XL", reviewStatus: "changes_requested" });
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		expect(getDecision()).toBe("deny");
	});
});

describe("preToolUse — review gate", () => {
	it("denies Edit when spec-review gate is active", async () => {
		setupSpec({ size: "L", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "test-task",
			reason: "Spec created.",
		});
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		expect(getDecision()).toBe("deny");
	});

	it("denies Write when wave-review gate is active", async () => {
		setupSpec({ size: "L", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "wave-review",
			slug: "test-task",
			wave: 1,
			reason: "Wave 1 review.",
		});
		await preToolUse(makeEvent("Write", join(tmpDir, "src/new.ts")));
		expect(getDecision()).toBe("deny");
	});

	it("allows Edit to project-external file when gate is active (#16)", async () => {
		setupSpec({ size: "L", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "test-task",
			reason: "Spec created.",
		});
		// File outside project dir (e.g., ~/.claude/memory/)
		await preToolUse(makeEvent("Edit", "/Users/someone/.claude/memory/test.md"));
		expect(getDecision()).toBe("allow");
	});

	it("allows Edit to docs/ when gate is active (#16)", async () => {
		setupSpec({ size: "L", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "test-task",
			reason: "Spec created.",
		});
		await preToolUse(makeEvent("Edit", join(tmpDir, "docs/roadmap/v0.4.md")));
		expect(getDecision()).toBe("allow");
	});

	it("allows Edit to root-level .md when gate is active (#16)", async () => {
		setupSpec({ size: "L", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "test-task",
			reason: "Spec created.",
		});
		await preToolUse(makeEvent("Edit", join(tmpDir, "CLAUDE.md")));
		expect(getDecision()).toBe("allow");
	});

	it("still denies Edit to src/ when gate is active (#16)", async () => {
		setupSpec({ size: "L", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "test-task",
			reason: "Spec created.",
		});
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		expect(getDecision()).toBe("deny");
	});

	it("allows Edit when gate slug does not match active spec (stale gate ignored)", async () => {
		setupSpec({ size: "L", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "other-task",
			reason: "Old spec.",
		});
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		expect(getDecision()).toBe("allow");
	});

	it("allows .alfred/ edits even when gate is active", async () => {
		setupSpec({ size: "L", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "test-task",
			reason: "Spec created.",
		});
		await preToolUse(makeEvent("Edit", join(tmpDir, ".alfred/specs/test-task/design.md")));
		expect(getDecision()).toBe("allow");
	});

	it("gate takes priority over approval gate", async () => {
		setupSpec({ size: "M", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "test-task",
			reason: "Spec created.",
		});
		await preToolUse(makeEvent("Edit", join(tmpDir, "src/index.ts")));
		expect(getDecision()).toBe("deny");
		const reason = getOutput()?.hookSpecificOutput?.permissionDecisionReason ?? "";
		expect(reason).toContain("Spec self-review");
	});
});
