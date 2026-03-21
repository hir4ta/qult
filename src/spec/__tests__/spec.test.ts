import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActiveState, TaskStatus } from "../types.js";
import {
	completeTask,
	detectSize,
	effectiveStatus,
	filesForSize,
	isTaskStatus,
	parseSize,
	parseSpecType,
	readActiveState,
	removeTask,
	reviewStatusFor,
	SpecDir,
	setReviewStatus,
	switchActive,
	transitionStatus,
	VALID_SLUG,
	VALID_TRANSITIONS,
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
		expect(parseSize("l")).toBe("L");
	});
	it("rejects XL (removed)", () => {
		expect(() => parseSize("XL")).toThrow("invalid spec size");
		expect(() => parseSize("xl")).toThrow("invalid spec size");
	});
	it("rejects D (removed)", () => {
		expect(() => parseSize("D")).toThrow("invalid spec size");
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
	it("rejects delta (removed)", () => {
		expect(() => parseSpecType("delta")).toThrow("invalid spec type");
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
	it("S feature has 3 files (requirements + design + tasks)", () => {
		const files = filesForSize("S", "feature");
		expect(files).toHaveLength(3);
		expect(files).toEqual(["requirements.md", "design.md", "tasks.md"]);
	});
	it("S bugfix has 3 files (bugfix + design + tasks)", () => {
		const files = filesForSize("S", "bugfix");
		expect(files).toHaveLength(3);
		expect(files).toEqual(["bugfix.md", "design.md", "tasks.md"]);
	});
	it("M feature has 4 files", () => {
		const files = filesForSize("M", "feature");
		expect(files).toHaveLength(4);
		expect(files).toEqual(["requirements.md", "design.md", "tasks.md", "test-specs.md"]);
	});
	it("M bugfix has 4 files (design.md included)", () => {
		const files = filesForSize("M", "bugfix");
		expect(files).toHaveLength(4);
		expect(files).toEqual(["bugfix.md", "design.md", "tasks.md", "test-specs.md"]);
	});
	it("L feature has 5 files", () => {
		const files = filesForSize("L", "feature");
		expect(files).toHaveLength(5);
		expect(files).toEqual(["requirements.md", "design.md", "tasks.md", "test-specs.md", "research.md"]);
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
		expect(() => switchActive(tmpDir, "task-b")).toThrow("done");
	});

	it("completes task, removes it from _active.md, and switches primary", () => {
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
		expect(state.tasks.find((t) => t.slug === "task-a")).toBeUndefined();
		expect(state.tasks).toHaveLength(1);
	});

	it("deletes _active.md when last task is completed", () => {
		writeTestState({
			primary: "task-a",
			tasks: [{ slug: "task-a", started_at: "2026-01-01T00:00:00Z" }],
		});
		const newPrimary = completeTask(tmpDir, "task-a");
		expect(newPrimary).toBe("");
		expect(() => readActiveState(tmpDir)).toThrow();
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

describe("TaskStatus", () => {
	describe("transitionStatus", () => {
		it("allows valid transitions", () => {
			expect(transitionStatus("pending", "in-progress")).toBe("in-progress");
			expect(transitionStatus("pending", "cancelled")).toBe("cancelled");
			expect(transitionStatus("in-progress", "review")).toBe("review");
			expect(transitionStatus("in-progress", "deferred")).toBe("deferred");
			expect(transitionStatus("in-progress", "cancelled")).toBe("cancelled");
			expect(transitionStatus("review", "in-progress")).toBe("in-progress");
			expect(transitionStatus("review", "done")).toBe("done");
			expect(transitionStatus("review", "cancelled")).toBe("cancelled");
			expect(transitionStatus("deferred", "in-progress")).toBe("in-progress");
			expect(transitionStatus("deferred", "cancelled")).toBe("cancelled");
		});

		it("rejects invalid transitions", () => {
			expect(() => transitionStatus("done", "pending")).toThrow("InvalidTransition");
			expect(() => transitionStatus("cancelled", "in-progress")).toThrow("InvalidTransition");
			expect(() => transitionStatus("pending", "done")).toThrow("InvalidTransition");
			expect(() => transitionStatus("pending", "review")).toThrow("InvalidTransition");
		});

		it("rejects same-state transitions", () => {
			expect(() => transitionStatus("pending", "pending")).toThrow("same state");
		});

		it("rejects transitions from terminal states", () => {
			for (const target of ["pending", "in-progress", "review", "deferred", "cancelled"] as TaskStatus[]) {
				expect(() => transitionStatus("done", target)).toThrow("InvalidTransition");
				expect(() => transitionStatus("cancelled", target)).toThrow("InvalidTransition");
			}
		});

		it("covers all VALID_TRANSITIONS entries", () => {
			for (const [from, toSet] of VALID_TRANSITIONS) {
				for (const to of toSet) {
					expect(transitionStatus(from, to)).toBe(to);
				}
			}
		});
	});

	describe("effectiveStatus", () => {
		it("maps undefined to in-progress", () => {
			expect(effectiveStatus(undefined)).toBe("in-progress");
		});
		it("maps 'active' to in-progress", () => {
			expect(effectiveStatus("active")).toBe("in-progress");
		});
		it("maps 'completed' to done", () => {
			expect(effectiveStatus("completed")).toBe("done");
		});
		it("passes through valid statuses", () => {
			expect(effectiveStatus("pending")).toBe("pending");
			expect(effectiveStatus("review")).toBe("review");
			expect(effectiveStatus("deferred")).toBe("deferred");
			expect(effectiveStatus("cancelled")).toBe("cancelled");
		});
		it("maps unknown strings to in-progress", () => {
			expect(effectiveStatus("invalid")).toBe("in-progress");
		});
	});

	describe("isTaskStatus", () => {
		it("returns true for valid statuses", () => {
			expect(isTaskStatus("pending")).toBe(true);
			expect(isTaskStatus("in-progress")).toBe(true);
			expect(isTaskStatus("review")).toBe(true);
			expect(isTaskStatus("done")).toBe(true);
			expect(isTaskStatus("deferred")).toBe(true);
			expect(isTaskStatus("cancelled")).toBe(true);
		});
		it("returns false for invalid strings", () => {
			expect(isTaskStatus("active")).toBe(false);
			expect(isTaskStatus("completed")).toBe(false);
			expect(isTaskStatus("")).toBe(false);
		});
	});
});
