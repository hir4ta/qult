import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookEvent } from "../dispatcher.js";
import { writeReviewGate } from "../review-gate.js";
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

function setupSpec(opts: { size?: string; status?: string }): void {
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
}

function makeEvent(opts?: { stopHookActive?: boolean }): HookEvent {
	return {
		cwd: tmpDir,
		stop_hook_active: opts?.stopHookActive,
	};
}

function getBlockOutput(): string | null {
	return stderrData.find((s) => s.includes("[CONTEXT]")) ?? null;
}

describe("stop", () => {
	it("allows stop when stop_hook_active=true (DEC-4 infinite loop prevention)", async () => {
		setupSpec({ size: "M" });
		writeReviewGate(tmpDir, { gate: "spec-review", slug: "test-task", reason: "Test" });
		await stop(makeEvent({ stopHookActive: true }));
		expect(stderrData.length).toBe(0);
	});

	it("allows stop when no active spec", async () => {
		await stop(makeEvent());
		expect(stderrData.length).toBe(0);
	});

	it("allows stop when no review gate", async () => {
		setupSpec({ size: "M" });
		await stop(makeEvent());
		expect(stderrData.length).toBe(0);
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
		expect(block).not.toBeNull();
		expect(block).toContain("Spec self-review");
	});

	it("BLOCKS with wave review label", async () => {
		setupSpec({ size: "M" });
		writeReviewGate(tmpDir, {
			gate: "wave-review",
			slug: "test-task",
			wave: 1,
			reason: "Wave 1 review",
		});
		await stop(makeEvent());
		const block = getBlockOutput();
		expect(block).not.toBeNull();
		expect(block).toContain("Wave 1 review");
	});
});
