import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearReviewGate,
	isGateActive,
	readReviewGate,
	writeReviewGate,
} from "../review-gate.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "review-gate-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function setupAlfred(): void {
	mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
}

function setupSpec(slug: string): void {
	setupAlfred();
	const specsDir = join(tmpDir, ".alfred", "specs");
	mkdirSync(specsDir, { recursive: true });
	const state = { primary: slug, tasks: [{ slug, started_at: "2026-01-01T00:00:00Z", size: "L" }] };
	writeFileSync(join(specsDir, "_active.json"), JSON.stringify(state));
}

describe("readReviewGate", () => {
	it("returns null when no gate file exists", () => {
		setupAlfred();
		expect(readReviewGate(tmpDir)).toBeNull();
	});

	it("returns gate when file exists with valid data", () => {
		setupAlfred();
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "my-task",
			reason: "Spec created.",
		});
		const gate = readReviewGate(tmpDir);
		expect(gate).not.toBeNull();
		expect(gate!.gate).toBe("spec-review");
		expect(gate!.slug).toBe("my-task");
		expect(gate!.set_at).toBeTruthy();
	});

	it("returns null for corrupted JSON (fail-open)", () => {
		setupAlfred();
		writeFileSync(join(tmpDir, ".alfred", ".state", "review-gate.json"), "not json{{{");
		expect(readReviewGate(tmpDir)).toBeNull();
	});

	it("returns null for invalid gate type", () => {
		setupAlfred();
		writeFileSync(
			join(tmpDir, ".alfred", ".state", "review-gate.json"),
			JSON.stringify({ gate: "invalid", slug: "x", reason: "y" }),
		);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		expect(readReviewGate(tmpDir)).toBeNull();
		expect(stderr).toHaveBeenCalled();
	});

	it("returns null when gate or slug is missing", () => {
		setupAlfred();
		writeFileSync(
			join(tmpDir, ".alfred", ".state", "review-gate.json"),
			JSON.stringify({ gate: "spec-review" }),
		);
		expect(readReviewGate(tmpDir)).toBeNull();
	});
});

describe("writeReviewGate + clearReviewGate", () => {
	it("writes and clears gate", () => {
		setupAlfred();
		writeReviewGate(tmpDir, {
			gate: "wave-review",
			slug: "my-task",
			wave: 1,
			reason: "Wave 1 review.",
		});
		const gate = readReviewGate(tmpDir);
		expect(gate).not.toBeNull();
		expect(gate!.gate).toBe("wave-review");
		expect(gate!.wave).toBe(1);

		clearReviewGate(tmpDir);
		expect(readReviewGate(tmpDir)).toBeNull();
	});
});

describe("isGateActive", () => {
	it("returns gate when slug matches active spec", () => {
		setupSpec("my-task");
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "my-task",
			reason: "Spec created.",
		});
		const gate = isGateActive(tmpDir);
		expect(gate).not.toBeNull();
		expect(gate!.slug).toBe("my-task");
	});

	it("returns null when slug does not match active spec (stale gate)", () => {
		setupSpec("task-b");
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "task-a",
			reason: "Old spec.",
		});
		expect(isGateActive(tmpDir)).toBeNull();
	});

	it("returns null when no active spec", () => {
		setupAlfred();
		writeReviewGate(tmpDir, {
			gate: "spec-review",
			slug: "my-task",
			reason: "Spec created.",
		});
		expect(isGateActive(tmpDir)).toBeNull();
	});

	it("returns null when no gate exists", () => {
		setupSpec("my-task");
		expect(isGateActive(tmpDir)).toBeNull();
	});
});
