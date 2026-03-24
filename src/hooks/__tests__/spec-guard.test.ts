import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	countUncheckedTasks,
	hasUncheckedSelfReview,
	isSpecFilePath,
	tryReadActiveSpec,
} from "../spec-guard.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "spec-guard-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupSpec(opts: {
	primary?: string;
	size?: string;
	status?: string;
	tasksContent?: string;
}): void {
	const slug = opts.primary ?? "test-task";
	const specsDir = join(tmpDir, ".alfred", "specs");
	mkdirSync(specsDir, { recursive: true });

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

	if (opts.tasksContent) {
		const taskDir = join(specsDir, slug);
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(join(taskDir, "tasks.md"), opts.tasksContent);
	}
}

describe("tryReadActiveSpec", () => {
	it("returns spec state from _active.json", () => {
		setupSpec({ size: "M", status: "active" });
		const spec = tryReadActiveSpec(tmpDir);
		expect(spec).not.toBeNull();
		expect(spec!.slug).toBe("test-task");
		expect(spec!.size).toBe("M");
	});

	it("returns null when _active.json missing (fail-open)", () => {
		expect(tryReadActiveSpec(tmpDir)).toBeNull();
	});

	it("returns null when cwd is undefined", () => {
		expect(tryReadActiveSpec(undefined)).toBeNull();
	});

	it("returns null when primary is empty", () => {
		const specsDir = join(tmpDir, ".alfred", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(join(specsDir, "_active.json"), JSON.stringify({ primary: "", tasks: [] }));
		expect(tryReadActiveSpec(tmpDir)).toBeNull();
	});
});

describe("isSpecFilePath", () => {
	it("returns true for .alfred/ paths", () => {
		expect(isSpecFilePath(tmpDir, join(tmpDir, ".alfred", "specs", "task", "design.md"))).toBe(
			true,
		);
	});

	it("returns true for relative .alfred/ paths", () => {
		expect(isSpecFilePath(tmpDir, ".alfred/specs/task/design.md")).toBe(true);
	});

	it("returns false for src/ paths", () => {
		expect(isSpecFilePath(tmpDir, join(tmpDir, "src", "index.ts"))).toBe(false);
	});

	it("returns false for .alfred-sibling directories", () => {
		expect(isSpecFilePath(tmpDir, join(tmpDir, ".alfred-backup", "secrets.ts"))).toBe(false);
	});

	it("returns false for empty inputs", () => {
		expect(isSpecFilePath(undefined, "foo")).toBe(false);
		expect(isSpecFilePath(tmpDir, "")).toBe(false);
	});
});

describe("countUncheckedTasks", () => {
	it("counts unchecked items in tasks.md", () => {
		setupSpec({
			tasksContent: "# Tasks\n- [x] Done\n- [ ] Todo 1\n- [ ] Todo 2\n",
		});
		expect(countUncheckedTasks(tmpDir, "test-task")).toBe(2);
	});

	it("returns 0 when all checked", () => {
		setupSpec({
			tasksContent: "# Tasks\n- [x] Done 1\n- [x] Done 2\n",
		});
		expect(countUncheckedTasks(tmpDir, "test-task")).toBe(0);
	});

	it("returns 0 when no tasks.md", () => {
		expect(countUncheckedTasks(tmpDir, "nonexistent")).toBe(0);
	});
});

describe("hasUncheckedSelfReview", () => {
	it("detects unchecked self-review (Japanese)", () => {
		setupSpec({
			tasksContent: "# Tasks\n- [x] Implementation\n- [ ] Wave 1 セルフレビュー\n",
		});
		expect(hasUncheckedSelfReview(tmpDir, "test-task")).toBe(true);
	});

	it("detects unchecked self-review (English)", () => {
		setupSpec({
			tasksContent: "# Tasks\n- [ ] Wave 1 self-review\n",
		});
		expect(hasUncheckedSelfReview(tmpDir, "test-task")).toBe(true);
	});

	it("returns false when self-review is checked", () => {
		setupSpec({
			tasksContent: "# Tasks\n- [x] Wave 1 セルフレビュー\n- [ ] Other task\n",
		});
		expect(hasUncheckedSelfReview(tmpDir, "test-task")).toBe(false);
	});

	it("returns false when no self-review item", () => {
		setupSpec({
			tasksContent: "# Tasks\n- [ ] Implementation\n",
		});
		expect(hasUncheckedSelfReview(tmpDir, "test-task")).toBe(false);
	});
});
