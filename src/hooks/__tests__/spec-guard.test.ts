import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
		expect(isSpecFilePath(tmpDir, join(tmpDir, ".alfred", "specs", "task", "design.md"))).toBe(true);
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
