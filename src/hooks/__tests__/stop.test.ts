import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookEvent } from "../dispatcher.js";
import { writeReviewGate } from "../review-gate.js";
import { stop } from "../stop.js";

let tmpDir: string;
let stdoutData: string[];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "stop-"));
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

function setupSpec(opts: {
	size?: string;
	reviewStatus?: string;
	status?: string;
	sessionContent?: string;
}): void {
	const slug = "test-task";
	const specsDir = join(tmpDir, ".alfred", "specs");
	mkdirSync(join(specsDir, slug), { recursive: true });

	let yaml = `primary: ${slug}\ntasks:\n  - slug: ${slug}\n    started_at: 2026-01-01T00:00:00Z\n`;
	if (opts.size) yaml += `    size: ${opts.size}\n`;
	if (opts.reviewStatus) yaml += `    review_status: ${opts.reviewStatus}\n`;
	if (opts.status) yaml += `    status: ${opts.status}\n`;
	writeFileSync(join(specsDir, "_active.md"), yaml);

	if (opts.sessionContent) {
		writeFileSync(join(specsDir, slug, "session.md"), opts.sessionContent);
	}
}

function makeEvent(opts?: { stopHookActive?: boolean }): HookEvent {
	return {
		cwd: tmpDir,
		stop_hook_active: opts?.stopHookActive,
	};
}

function getBlockOutput(): { decision?: string } | null {
	for (const line of stdoutData) {
		try {
			const parsed = JSON.parse(line.trim());
			if (parsed.decision) return parsed;
		} catch {}
	}
	return null;
}

function getContextOutput(): string {
	return stdoutData.join("");
}

describe("stop", () => {
	it("allows stop when stop_hook_active=true (DEC-4 infinite loop prevention)", async () => {
		setupSpec({ size: "M", sessionContent: "## Next Steps\n- [ ] Unchecked\n" });
		await stop(makeEvent({ stopHookActive: true }));
		expect(stdoutData.length).toBe(0);
	});

	it("does NOT block on unchecked Next Steps (CONTEXT only)", async () => {
		setupSpec({
			size: "M",
			sessionContent: "## Next Steps\n- [x] Done\n- [ ] Todo 1\n- [ ] Todo 2\n",
		});
		await stop(makeEvent());
		const block = getBlockOutput();
		expect(block).toBeNull(); // No block
		const ctx = getContextOutput();
		expect(ctx).toContain("unchecked Next Steps");
	});

	it("does NOT block on unchecked self-review (CONTEXT only)", async () => {
		setupSpec({
			size: "M",
			sessionContent: "## Next Steps\n- [ ] セルフレビュー\n",
		});
		await stop(makeEvent());
		expect(getBlockOutput()).toBeNull();
		expect(getContextOutput()).toContain("Self-review");
	});

	it("emits dossier complete reminder as CONTEXT", async () => {
		setupSpec({
			size: "M",
			sessionContent: "## Next Steps\n- [x] All done\n",
		});
		await stop(makeEvent());
		expect(getBlockOutput()).toBeNull();
		expect(getContextOutput()).toContain("dossier action=complete");
	});

	it("allows stop when no active spec", async () => {
		await stop(makeEvent());
		expect(stdoutData.length).toBe(0);
	});

	it("allows stop when spec is completed", async () => {
		setupSpec({
			size: "M",
			status: "completed",
			sessionContent: "## Next Steps\n- [ ] Something unchecked\n",
		});
		await stop(makeEvent());
		expect(stdoutData.length).toBe(0);
	});

	it("BLOCKS when review-gate is active", async () => {
		setupSpec({ size: "L", reviewStatus: "approved" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "test-task",
			reason: "Spec created.",
		});
		await stop(makeEvent());
		const block = getBlockOutput();
		expect(block?.decision).toBe("block");
	});
});
