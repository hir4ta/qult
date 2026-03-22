import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderForSize } from "../templates.js";
import type { SpecFile, SpecSize, SpecType } from "../types.js";
import { validateSpec } from "../validate.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "validate-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function initSpec(
	slug: string,
	size: SpecSize,
	specType: SpecType,
	overrides?: Partial<Record<SpecFile, string>>,
): void {
	const specDir = join(tmpDir, ".alfred", "specs", slug);
	mkdirSync(specDir, { recursive: true });

	const rendered = renderForSize(size, specType, {
		taskSlug: slug,
		description: "Test spec",
		date: "2026-03-18",
		specType,
	});

	for (const [file, content] of rendered) {
		writeFileSync(join(specDir, file), overrides?.[file] ?? content);
	}
}

describe("validateSpec — template defaults", () => {
	it("S spec defaults have no fail checks (NFR-3)", () => {
		initSpec("test-s", "S", "feature");
		const result = validateSpec(tmpDir, "test-s", "S", "feature");
		const fails = result.checks.filter((c) => c.status === "fail");
		expect(fails).toEqual([]);
	});

	it("M spec defaults have no fail checks (NFR-3)", () => {
		initSpec("test-m", "M", "feature");
		const result = validateSpec(tmpDir, "test-m", "M", "feature");
		const fails = result.checks.filter((c) => c.status === "fail");
		expect(fails).toEqual([]);
	});

	it("L spec defaults have no fail checks (NFR-3)", () => {
		initSpec("test-l", "L", "feature");
		const result = validateSpec(tmpDir, "test-l", "L", "feature");
		const fails = result.checks.filter((c) => c.status === "fail");
		expect(fails).toEqual([]);
	});

	it("bugfix spec defaults have no fail checks (NFR-3)", () => {
		initSpec("test-bug", "M", "bugfix");
		const result = validateSpec(tmpDir, "test-bug", "M", "bugfix");
		const fails = result.checks.filter((c) => c.status === "fail");
		expect(fails).toEqual([]);
	});
});

describe("validateSpec — traceability", () => {
	it("detects unreferenced FR in tasks (fr_to_task)", () => {
		initSpec("test-trace", "L", "feature", {
			"requirements.md": `# Req\n## Functional Requirements\n### FR-1: A\n### FR-2: B\n## Non-Functional Requirements\n`,
			"tasks.md": `# Tasks\n## Wave 1\n### T-1.1: Do A\n- Requirements: FR-1\n## Wave: Closing\n- [ ] Review\n`,
		});
		const result = validateSpec(tmpDir, "test-trace", "L", "feature");
		const frToTask = result.checks.find((c) => c.name === "fr_to_task");
		expect(frToTask?.status).toBe("fail");
		expect(frToTask?.message).toContain("FR-2");
	});

	it("passes when all FR referenced", () => {
		initSpec("test-trace2", "L", "feature", {
			"requirements.md": `# Req\n## Functional Requirements\n### FR-1: A\n## Non-Functional Requirements\n`,
			"tasks.md": `# Tasks\n## Wave 1\n### T-1.1: Do A\n- Requirements: FR-1\n## Wave: Closing\n- [ ] Review\n`,
		});
		const result = validateSpec(tmpDir, "test-trace2", "L", "feature");
		const frToTask = result.checks.find((c) => c.name === "fr_to_task");
		expect(frToTask?.status).toBe("pass");
	});
});

describe("validateSpec — size-conditional checks", () => {
	it("S does not include L-only checks", () => {
		initSpec("test-s2", "S", "feature");
		const result = validateSpec(tmpDir, "test-s2", "S", "feature");
		const checkNames = result.checks.map((c) => c.name);
		expect(checkNames).not.toContain("xl_wave_count");
		expect(checkNames).not.toContain("decisions_completeness");
		expect(checkNames).not.toContain("nfr_traceability");
	});
});

describe("validateSpec — min_fr_count", () => {
	it("fails S spec with 0 FRs", () => {
		initSpec("test-nofr", "S", "feature", {
			"requirements.md": "# Requirements\n## Goal\n## Functional Requirements\n\nNothing here\n",
		});
		const result = validateSpec(tmpDir, "test-nofr", "S", "feature");
		const check = result.checks.find((c) => c.name === "min_fr_count");
		expect(check?.status).toBe("fail");
	});
});

describe("validateSpec — JA template defaults (NFR-3)", () => {
	const origLang = process.env.ALFRED_LANG;
	beforeEach(() => { process.env.ALFRED_LANG = "ja"; });
	afterEach(() => { process.env.ALFRED_LANG = origLang; });

	it("L spec JA defaults have no fail checks", () => {
		initSpec("test-l-ja", "L", "feature");
		const result = validateSpec(tmpDir, "test-l-ja", "L", "feature");
		const fails = result.checks.filter((c) => c.status === "fail");
		expect(fails).toEqual([]);
	});

});

describe("validateSpec — performance (NFR-1)", () => {
	it("validates L spec in under 100ms", () => {
		initSpec("test-perf", "L", "feature");
		const t0 = performance.now();
		validateSpec(tmpDir, "test-perf", "L", "feature");
		const elapsed = performance.now() - t0;
		expect(elapsed).toBeLessThan(100);
	});
});
