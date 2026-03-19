import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderForSize } from "../templates.js";
import type { SpecFile, SpecSize, SpecType } from "../types.js";
import { validateSpec } from "../validate.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "validate-strict-"));
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
		date: "2026-03-19",
		specType,
	});

	for (const [file, content] of rendered) {
		writeFileSync(join(specDir, file), overrides?.[file] ?? content);
	}
}

describe("validateSpec — strict mode", () => {
	it("strict mode promotes warn to fail for min_fr_count", () => {
		initSpec("test-strict", "M", "feature", {
			"requirements.md":
				"# Requirements\n## Goal\nTest\n## Functional Requirements\n### FR-1: Only one\n<!-- confidence: 8 | source: user | grounding: verified -->\n## Non-Functional Requirements\n",
		});
		// Normal mode: warn (1 FR < 3 required for M, but > 0)
		const normal = validateSpec(tmpDir, "test-strict", "M", "feature");
		const frCheck = normal.checks.find((c) => c.name === "min_fr_count");
		expect(frCheck?.status).toBe("warn");

		// Strict mode: fail
		const strict = validateSpec(tmpDir, "test-strict", "M", "feature", { strict: true });
		const frCheckStrict = strict.checks.find((c) => c.name === "min_fr_count");
		expect(frCheckStrict?.status).toBe("fail");
		expect(strict.failed).toBeGreaterThan(normal.failed);
	});

	it("strict mode promotes placeholder warnings to fail", () => {
		initSpec("test-placeholder", "S", "feature", {
			"requirements.md":
				"# Requirements\n## Goal\n[TODO] fill this\n## Functional Requirements\n### FR-1: Something\n## Non-Functional Requirements\n",
		});
		const normal = validateSpec(tmpDir, "test-placeholder", "S", "feature");
		const phCheck = normal.checks.find((c) => c.name === "content_placeholder");
		expect(phCheck?.status).toBe("warn");

		const strict = validateSpec(tmpDir, "test-placeholder", "S", "feature", { strict: true });
		const phCheckStrict = strict.checks.find((c) => c.name === "content_placeholder");
		expect(phCheckStrict?.status).toBe("fail");
	});

	it("non-strict mode keeps warns as warns (backward compat)", () => {
		initSpec("test-compat", "S", "feature");
		const result = validateSpec(tmpDir, "test-compat", "S", "feature");
		// Template defaults should have no fails (NFR-3 preserved)
		const fails = result.checks.filter((c) => c.status === "fail");
		expect(fails).toEqual([]);
	});

	it("strict mode does not affect passing checks", () => {
		initSpec("test-pass", "S", "feature");
		const normal = validateSpec(tmpDir, "test-pass", "S", "feature");
		const strict = validateSpec(tmpDir, "test-pass", "S", "feature", { strict: true });
		// Passing checks remain passing
		const normalPass = normal.checks.filter((c) => c.status === "pass").length;
		const strictPass = strict.checks.filter((c) => c.status === "pass").length;
		expect(strictPass).toBe(normalPass);
	});
});

describe("validateSpec — negative tests (bad specs should fail)", () => {
	it("fails M spec with 0 FRs", () => {
		initSpec("test-nofr-m", "M", "feature", {
			"requirements.md": "# Requirements\n## Goal\nNothing\n## Functional Requirements\n\n## Non-Functional Requirements\n",
		});
		const result = validateSpec(tmpDir, "test-nofr-m", "M", "feature");
		const check = result.checks.find((c) => c.name === "min_fr_count");
		expect(check?.status).toBe("fail");
	});

	it("fails spec missing closing wave", () => {
		initSpec("test-noclosing", "M", "feature", {
			"tasks.md": "# Tasks\n## Wave 1\n### T-1.1: Do something\n- Requirements: FR-1\n",
		});
		const result = validateSpec(tmpDir, "test-noclosing", "M", "feature");
		const check = result.checks.find((c) => c.name === "closing_wave");
		expect(check?.status).toBe("fail");
	});

	it("fails spec with FR not referenced in tasks (fr_to_task)", () => {
		initSpec("test-orphan-fr", "M", "feature", {
			"requirements.md":
				"# Requirements\n## Functional Requirements\n### FR-1: A\n### FR-2: B\n### FR-3: C\n## Non-Functional Requirements\n",
			"tasks.md":
				"# Tasks\n## Wave 1\n### T-1.1: Do A\n- Requirements: FR-1\n## Wave: Closing\n- [ ] Review\n",
		});
		const result = validateSpec(tmpDir, "test-orphan-fr", "M", "feature");
		const check = result.checks.find((c) => c.name === "fr_to_task");
		expect(check?.status).toBe("fail");
		expect(check?.message).toContain("FR-2");
		expect(check?.message).toContain("FR-3");
	});

	it("passes task_to_fr with checkbox format tasks.md", () => {
		initSpec("test-checkbox-fmt", "M", "feature", {
			"requirements.md":
				"# Requirements\n## Functional Requirements\n### FR-1: A\n### FR-2: B\n## Non-Functional Requirements\n",
			"tasks.md":
				"# Tasks\n## Wave 1\n- [x] T-1.1 [S] Do A\n  _Requirements: FR-1 | Files: src/a.ts_\n- [ ] T-1.2 [S] Do B\n  _Requirements: FR-2 | Files: src/b.ts_\n## Wave: Closing\n- [ ] T-C.1 Review\n",
		});
		const result = validateSpec(tmpDir, "test-checkbox-fmt", "M", "feature");
		const frToTask = result.checks.find((c) => c.name === "fr_to_task");
		expect(frToTask?.status).toBe("pass");
		const taskToFr = result.checks.find((c) => c.name === "task_to_fr");
		expect(taskToFr?.status).toBe("pass");
	});

	it("warns on tasks without FR reference in strict → fails", () => {
		initSpec("test-task-nofr", "M", "feature", {
			"requirements.md":
				"# Requirements\n## Functional Requirements\n### FR-1: A\n## Non-Functional Requirements\n",
			"tasks.md":
				"# Tasks\n## Wave 1\n### T-1.1: Do A\n- Requirements: FR-1\n### T-1.2: Do B\n- No requirements here\n## Wave: Closing\n- [ ] Review\n",
		});
		const normal = validateSpec(tmpDir, "test-task-nofr", "M", "feature");
		const check = normal.checks.find((c) => c.name === "task_to_fr");
		expect(check?.status).toBe("warn");

		const strict = validateSpec(tmpDir, "test-task-nofr", "M", "feature", { strict: true });
		const checkStrict = strict.checks.find((c) => c.name === "task_to_fr");
		expect(checkStrict?.status).toBe("fail");
	});
});
