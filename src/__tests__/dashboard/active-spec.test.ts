import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveSpecForDashboard, inferPhase } from "../../dashboard/state/active-spec.ts";
import { setProjectRoot } from "../../state/paths.ts";

let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-dash-active-"));
	setProjectRoot(tmpRoot);
});

afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSpec(name: string, files: { req?: boolean; design?: boolean; tasks?: boolean }): void {
	const dir = join(tmpRoot, ".qult", "specs", name);
	mkdirSync(dir, { recursive: true });
	if (files.req) writeFileSync(join(dir, "requirements.md"), "# req");
	if (files.design) writeFileSync(join(dir, "design.md"), "# design");
	if (files.tasks) writeFileSync(join(dir, "tasks.md"), "# tasks");
}

describe("inferPhase", () => {
	it("classifies by which artifacts exist", () => {
		const base = { specName: "x", wavesDirExists: false };
		expect(inferPhase({ ...base, hasRequirements: false, hasDesign: false, hasTasks: false })).toBe(
			"requirements",
		);
		expect(inferPhase({ ...base, hasRequirements: true, hasDesign: false, hasTasks: false })).toBe(
			"requirements",
		);
		expect(inferPhase({ ...base, hasRequirements: true, hasDesign: true, hasTasks: false })).toBe(
			"design",
		);
		expect(inferPhase({ ...base, hasRequirements: true, hasDesign: true, hasTasks: true })).toBe(
			"tasks",
		);
	});
});

describe("getActiveSpecForDashboard", () => {
	it("returns null when no specs exist", () => {
		expect(getActiveSpecForDashboard()).toBeNull();
	});

	it("returns spec name + design phase when requirements + design exist", () => {
		makeSpec("alpha", { req: true, design: true });
		const got = getActiveSpecForDashboard();
		expect(got).toEqual({ name: "alpha", phase: "design" });
	});

	it("returns implementation phase when waves/wave-NN.md exist", () => {
		makeSpec("alpha", { req: true, design: true, tasks: true });
		const wavesPath = join(tmpRoot, ".qult", "specs", "alpha", "waves");
		mkdirSync(wavesPath, { recursive: true });
		writeFileSync(join(wavesPath, "wave-01.md"), "# Wave 1: x");
		const got = getActiveSpecForDashboard();
		expect(got).toEqual({ name: "alpha", phase: "implementation" });
	});

	it("returns null when multiple non-archived specs exist (ambiguous)", () => {
		makeSpec("alpha", { req: true });
		makeSpec("beta", { req: true });
		expect(getActiveSpecForDashboard()).toBeNull();
	});
});
