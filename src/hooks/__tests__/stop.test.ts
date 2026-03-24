import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookEvent } from "../dispatcher.js";
import { writeReviewGate } from "../review-gate.js";
import { addWorkedSlug, resetWorkedSlugs } from "../state.js";
import { stop } from "../stop.js";

let tmpDir: string;
let stdoutData: string[];
let stderrData: string[];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "stop-"));
	stdoutData = [];
	stderrData = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutData.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrData.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function setupSpec(opts: {
	size?: string;
	status?: string;
	sessionContent?: string;
}): void {
	const slug = "test-task";
	const specsDir = join(tmpDir, ".alfred", "specs");
	mkdirSync(join(specsDir, slug), { recursive: true });

	const state = {
		primary: slug,
		tasks: [{
			slug,
			started_at: "2026-01-01T00:00:00Z",
			...(opts.size ? { size: opts.size } : {}),
			...(opts.status ? { status: opts.status } : {}),
		}],
	};
	writeFileSync(join(specsDir, "_active.json"), JSON.stringify(state));

	if (opts.sessionContent) {
		writeFileSync(join(specsDir, slug, "tasks.md"), opts.sessionContent);
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
	return stderrData.join("");
}

describe("stop", () => {
	it("allows stop when stop_hook_active=true (DEC-4 infinite loop prevention)", async () => {
		setupSpec({ size: "M", sessionContent: "## Wave 1\n- [ ] Unchecked\n" });
		await stop(makeEvent({ stopHookActive: true }));
		expect(stdoutData.length).toBe(0);
	});

	it("does NOT block on unchecked task(s) (CONTEXT only, stderr)", async () => {
		setupSpec({
			size: "M",
			sessionContent: "## Wave 1\n- [x] Done\n- [ ] Todo 1\n- [ ] Todo 2\n",
		});
		await stop(makeEvent());
		const block = getBlockOutput();
		expect(block).toBeNull(); // No block
		expect(stdoutData.length).toBe(0); // No stdout (avoids JSON validation error)
		const ctx = getContextOutput();
		expect(ctx).toContain("unchecked task(s)");
	});

	it("does NOT block on unchecked self-review (CONTEXT only, stderr)", async () => {
		setupSpec({
			size: "M",
			sessionContent: "## Wave 1\n- [ ] セルフレビュー\n",
		});
		await stop(makeEvent());
		expect(getBlockOutput()).toBeNull();
		expect(stdoutData.length).toBe(0);
		expect(getContextOutput()).toContain("Self-review");
	});

	it("emits dossier complete reminder as CONTEXT via stderr", async () => {
		setupSpec({
			size: "M",
			sessionContent: "## Wave 1\n- [x] All done\n",
		});
		await stop(makeEvent());
		expect(getBlockOutput()).toBeNull();
		expect(stdoutData.length).toBe(0);
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
			sessionContent: "## Wave 1\n- [ ] Something unchecked\n",
		});
		await stop(makeEvent());
		expect(stdoutData.length).toBe(0);
	});

	it("BLOCKS when review-gate is active", async () => {
		setupSpec({ size: "M" });
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "test-task",
			reason: "Spec created.",
		});
		await stop(makeEvent());
		const block = getBlockOutput();
		expect(block?.decision).toBe("block");
	});

	it("skips reminders when primary spec was NOT worked on (session-scoped)", async () => {
		setupSpec({
			size: "M",
			sessionContent: "## Wave 1\n- [ ] Todo 1\n",
		});
		// Record a different slug as worked — primary 'test-task' was not worked on.
		mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
		resetWorkedSlugs(tmpDir);
		addWorkedSlug(tmpDir, "other-task");
		await stop(makeEvent());
		expect(stdoutData.length).toBe(0);
	});

	it("shows reminders when primary spec WAS worked on (session-scoped)", async () => {
		setupSpec({
			size: "M",
			sessionContent: "## Wave 1\n- [ ] Todo 1\n",
		});
		mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
		resetWorkedSlugs(tmpDir);
		addWorkedSlug(tmpDir, "test-task");
		await stop(makeEvent());
		expect(stdoutData.length).toBe(0);
		const ctx = getContextOutput();
		expect(ctx).toContain("unchecked task(s)");
	});

	it("falls back to primary spec when no worked-slugs recorded (read-only session)", async () => {
		setupSpec({
			size: "M",
			sessionContent: "## Wave 1\n- [ ] Todo 1\n",
		});
		// No worked-slugs at all (empty array or file doesn't exist).
		await stop(makeEvent());
		expect(stdoutData.length).toBe(0);
		const ctx = getContextOutput();
		expect(ctx).toContain("unchecked task(s)");
	});
});
