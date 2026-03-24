import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGitCommit, isTestFailure, detectWaveCompletion } from "../post-tool.js";
import { readStateJSON, writeWaveProgress } from "../state.js";
import type { ReviewGate } from "../review-gate.js";
import { readStateText, writeStateText } from "../state.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "post-tool-"));
	mkdirSync(join(tmpDir, ".alfred"), { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupTasksJson(slug: string, tasksJson: object) {
	const specsDir = join(tmpDir, ".alfred", "specs", slug);
	mkdirSync(specsDir, { recursive: true });
	const state = { primary: slug, tasks: [{ slug, started_at: "2025-01-01", status: "active", size: "M", spec_type: "feature" }] };
	writeFileSync(join(tmpDir, ".alfred", "specs", "_active.json"), JSON.stringify(state));
	writeFileSync(join(specsDir, "tasks.json"), JSON.stringify(tasksJson));
	writeFileSync(join(specsDir, "requirements.md"), "# Requirements");
}

describe("explore count via state", () => {
	it("starts at 0", () => {
		const count = parseInt(readStateText(tmpDir, "explore-count", "0"), 10) || 0;
		expect(count).toBe(0);
	});

	it("increments correctly", () => {
		writeStateText(tmpDir, "explore-count", "1");
		const count = parseInt(readStateText(tmpDir, "explore-count", "0"), 10);
		expect(count).toBe(1);
	});

	it("resets to 0", () => {
		writeStateText(tmpDir, "explore-count", "5");
		writeStateText(tmpDir, "explore-count", "0");
		const count = parseInt(readStateText(tmpDir, "explore-count", "0"), 10);
		expect(count).toBe(0);
	});

	it("reaches threshold at 5", () => {
		for (let i = 1; i <= 5; i++) {
			writeStateText(tmpDir, "explore-count", String(i));
		}
		const count = parseInt(readStateText(tmpDir, "explore-count", "0"), 10);
		expect(count).toBe(5);
		expect(count >= 5).toBe(true);
	});
});

describe("isTestFailure", () => {
	it("detects FAIL", () => expect(isTestFailure("FAIL src/test.ts")).toBe(true));
	it("detects FAILED", () => expect(isTestFailure("Tests FAILED")).toBe(true));
	it("detects FAILURE", () => expect(isTestFailure("FAILURE in test suite")).toBe(true));
	it('detects "N failed"', () => expect(isTestFailure("3 failed, 10 passed")).toBe(true));
	it("does not detect passing tests", () => expect(isTestFailure("All tests passed")).toBe(false));
	it("returns false for empty string", () => expect(isTestFailure("")).toBe(false));
});

describe("isGitCommit", () => {
	it("detects branch commit pattern", () => expect(isGitCommit("[main abc1234] fix: something")).toBe(true));
	it("detects feature branch commit", () => expect(isGitCommit("[feature/login 1a2b3c4] feat: add login")).toBe(true));
	it("detects diff stat pattern", () => expect(isGitCommit("3 files changed, 100 insertions(+), 20 deletions(-)")).toBe(true));
	it("does not detect regular output", () => expect(isGitCommit("npm test completed successfully")).toBe(false));
	it("returns false for empty string", () => expect(isGitCommit("")).toBe(false));
});

describe("detectWaveCompletion (JSON-based)", () => {
	it("emits DIRECTIVE and writes review-gate when wave completes", () => {
		setupTasksJson("test", {
			slug: "test",
			waves: [
				{ key: 1, title: "Setup", tasks: [
					{ id: "T-1.1", title: "First", checked: true },
					{ id: "T-1.2", title: "Second", checked: true },
				]},
				{ key: 2, title: "Impl", tasks: [
					{ id: "T-2.1", title: "Third", checked: false },
				]},
			],
			closing: { key: "closing", title: "Closing", tasks: [] },
		});
		const items = detectWaveCompletion(tmpDir, "test");
		expect(items.length).toBe(1);
		expect(items[0]!.level).toBe("DIRECTIVE");
		expect(items[0]!.message).toContain("Wave 1");

		const gate = readStateJSON<ReviewGate | null>(tmpDir, "review-gate.json", null);
		expect(gate).not.toBeNull();
		expect(gate!.gate).toBe("wave-review");
		expect(gate!.wave).toBe(1);
	});

	it("does not emit when wave is incomplete", () => {
		setupTasksJson("test", {
			slug: "test",
			waves: [
				{ key: 1, title: "Setup", tasks: [
					{ id: "T-1.1", title: "First", checked: true },
					{ id: "T-1.2", title: "Second", checked: false },
				]},
			],
			closing: { key: "closing", title: "Closing", tasks: [] },
		});
		const items = detectWaveCompletion(tmpDir, "test");
		expect(items.length).toBe(0);
	});

	it("does not emit for already-reviewed waves", () => {
		writeWaveProgress(tmpDir, {
			slug: "test",
			current_wave: 2,
			waves: { "1": { total: 2, checked: 2, reviewed: true } },
		});
		setupTasksJson("test", {
			slug: "test",
			waves: [
				{ key: 1, title: "Setup", tasks: [
					{ id: "T-1.1", title: "First", checked: true },
					{ id: "T-1.2", title: "Second", checked: true },
				]},
			],
			closing: { key: "closing", title: "Closing", tasks: [] },
		});
		const items = detectWaveCompletion(tmpDir, "test");
		expect(items.length).toBe(0);
	});
});
