import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActiveState } from "../types.js";
import {
	completeTask,
	detectSize,
	filesForSize,
	parseSize,
	parseSpecType,
	readActiveState,
	removeTask,
	reviewStatusFor,
	SpecDir,
	setReviewStatus,
	switchActive,
	VALID_SLUG,
	writeActiveState,
} from "../types.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "alfred-spec-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseSize", () => {
	it("parses valid sizes", () => {
		expect(parseSize("S")).toBe("S");
		expect(parseSize("m")).toBe("M");
		expect(parseSize("xl")).toBe("XL");
		expect(parseSize("D")).toBe("D");
	});
	it("throws on invalid size", () => {
		expect(() => parseSize("Z")).toThrow("invalid spec size");
	});
});

describe("parseSpecType", () => {
	it("parses valid types", () => {
		expect(parseSpecType("feature")).toBe("feature");
		expect(parseSpecType("bugfix")).toBe("bugfix");
		expect(parseSpecType("")).toBe("feature");
	});
	it("throws on invalid type", () => {
		expect(() => parseSpecType("unknown")).toThrow("invalid spec type");
	});
});

describe("detectSize", () => {
	it("returns S for short descriptions", () => {
		expect(detectSize("Fix a bug")).toBe("S");
	});
	it("returns M for medium descriptions", () => {
		expect(detectSize("A".repeat(150))).toBe("M");
	});
	it("returns L for long descriptions", () => {
		expect(detectSize("A".repeat(400))).toBe("L");
	});
});

describe("filesForSize", () => {
	it("S feature has 3 files", () => {
		expect(filesForSize("S", "feature")).toHaveLength(3);
		expect(filesForSize("S", "feature")).toContain("requirements.md");
	});
	it("M feature has 5 files", () => {
		expect(filesForSize("M", "feature")).toHaveLength(5);
	});
	it("L feature has 6 files (decisions.md removed)", () => {
		expect(filesForSize("L", "feature")).toHaveLength(6);
		expect(filesForSize("L", "feature")).not.toContain("decisions.md");
	});
	it("D has 2 files", () => {
		expect(filesForSize("D", "delta")).toEqual(["delta.md", "session.md"]);
	});
	it("bugfix uses bugfix.md as primary", () => {
		expect(filesForSize("S", "bugfix")[0]).toBe("bugfix.md");
	});
});

describe("VALID_SLUG", () => {
	it("accepts valid slugs", () => {
		expect(VALID_SLUG.test("my-feature")).toBe(true);
		expect(VALID_SLUG.test("fix-123")).toBe(true);
		expect(VALID_SLUG.test("a")).toBe(true);
	});
	it("rejects invalid slugs", () => {
		expect(VALID_SLUG.test("")).toBe(false);
		expect(VALID_SLUG.test("-start")).toBe(false);
		expect(VALID_SLUG.test("UPPER")).toBe(false);
		expect(VALID_SLUG.test("has space")).toBe(false);
	});
});

describe("ActiveState management", () => {
	function writeTestState(state: ActiveState) {
		writeActiveState(tmpDir, state);
	}

	it("writes and reads active state", () => {
		writeTestState({
			primary: "task-a",
			tasks: [{ slug: "task-a", started_at: "2026-01-01T00:00:00Z" }],
		});
		const state = readActiveState(tmpDir);
		expect(state.primary).toBe("task-a");
		expect(state.tasks).toHaveLength(1);
	});

	it("switches active task", () => {
		writeTestState({
			primary: "task-a",
			tasks: [
				{ slug: "task-a", started_at: "2026-01-01T00:00:00Z" },
				{ slug: "task-b", started_at: "2026-01-02T00:00:00Z" },
			],
		});
		switchActive(tmpDir, "task-b");
		expect(readActiveState(tmpDir).primary).toBe("task-b");
	});

	it("rejects switch to completed task", () => {
		writeTestState({
			primary: "task-a",
			tasks: [
				{ slug: "task-a", started_at: "2026-01-01T00:00:00Z" },
				{ slug: "task-b", started_at: "2026-01-02T00:00:00Z", status: "completed" },
			],
		});
		expect(() => switchActive(tmpDir, "task-b")).toThrow("completed");
	});

	it("completes task and switches primary", () => {
		writeTestState({
			primary: "task-a",
			tasks: [
				{ slug: "task-a", started_at: "2026-01-01T00:00:00Z" },
				{ slug: "task-b", started_at: "2026-01-02T00:00:00Z" },
			],
		});
		const newPrimary = completeTask(tmpDir, "task-a");
		expect(newPrimary).toBe("task-b");
		const state = readActiveState(tmpDir);
		expect(state.tasks.find((t) => t.slug === "task-a")?.status).toBe("completed");
	});

	it("manages review status", () => {
		writeTestState({
			primary: "task-a",
			tasks: [{ slug: "task-a", started_at: "2026-01-01T00:00:00Z" }],
		});
		setReviewStatus(tmpDir, "task-a", "approved");
		expect(reviewStatusFor(tmpDir, "task-a")).toBe("approved");
	});

	it("removes task", () => {
		writeTestState({
			primary: "task-a",
			tasks: [
				{ slug: "task-a", started_at: "2026-01-01T00:00:00Z" },
				{ slug: "task-b", started_at: "2026-01-02T00:00:00Z" },
			],
		});
		const allRemoved = removeTask(tmpDir, "task-a");
		expect(allRemoved).toBe(false);
		expect(readActiveState(tmpDir).primary).toBe("task-b");
	});
});

describe("SpecDir", () => {
	it("reports existence correctly", () => {
		const sd = new SpecDir(tmpDir, "test-task");
		expect(sd.exists()).toBe(false);
	});
});
