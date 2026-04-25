import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRecordReview } from "../../cli/commands/record-review.ts";
import { runRecordSpecEval } from "../../cli/commands/record-spec-eval.ts";
import { setProjectRoot } from "../../state/paths.ts";

let tmpRoot = "";
let stdoutWrites: string[] = [];
let stderrWrites: string[] = [];

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-recreview-"));
	mkdirSync(join(tmpRoot, ".qult", "state"), { recursive: true });
	setProjectRoot(tmpRoot);
	stdoutWrites = [];
	stderrWrites = [];
	vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
		stdoutWrites.push(typeof c === "string" ? c : Buffer.from(c).toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
		stderrWrites.push(typeof c === "string" ? c : Buffer.from(c).toString());
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

function statePath(): string {
	return join(tmpRoot, ".qult", "state", "stage-scores.json");
}

describe("runRecordReview", () => {
	it("rejects unknown stage", () => {
		const code = runRecordReview({ stage: "Bogus", scores: "{}" });
		expect(code).toBe(1);
		expect(stderrWrites.join("")).toContain("--stage must be one of");
	});

	it("requires --scores", () => {
		const code = runRecordReview({ stage: "Spec" });
		expect(code).toBe(1);
		expect(stderrWrites.join("")).toContain("--scores is required");
	});

	it("rejects scores out of range", () => {
		const code = runRecordReview({ stage: "Spec", scores: '{"x":6}' });
		expect(code).toBe(1);
		expect(stderrWrites.join("")).toContain("must be a number in [0, 5]");
	});

	it("writes a Spec stage score and reports the total", () => {
		const code = runRecordReview({
			stage: "Spec",
			scores: '{"a":4,"b":5,"c":3}',
		});
		expect(code).toBe(0);
		expect(stdoutWrites.join("")).toContain("recorded Spec: 12/15");
		const written = JSON.parse(readFileSync(statePath(), "utf8"));
		expect(written.review.Spec.scores).toEqual({ a: 4, b: 5, c: 3 });
	});

	it("emits JSON output when --json", () => {
		const code = runRecordReview({
			stage: "Quality",
			scores: '{"foo":5}',
			json: true,
		});
		expect(code).toBe(0);
		const out = JSON.parse(stdoutWrites.join(""));
		expect(out.stage).toBe("Quality");
		expect(out.total).toBe(5);
	});
});

describe("runRecordSpecEval", () => {
	it("rejects bad phase", () => {
		const code = runRecordSpecEval({ phase: "junk", total: "10", dim: "{}" });
		expect(code).toBe(1);
	});

	it("rejects out-of-range total", () => {
		const code = runRecordSpecEval({ phase: "design", total: "21", dim: '{"x":4}' });
		expect(code).toBe(1);
	});

	it("writes a phase score and persists fields", () => {
		const code = runRecordSpecEval({
			phase: "requirements",
			total: "19",
			dim: '{"completeness":5,"unambiguity":5,"testability":4,"feasibility":5}',
			iteration: "1",
		});
		expect(code).toBe(0);
		const written = JSON.parse(readFileSync(statePath(), "utf8"));
		expect(written.spec_eval.requirements.total).toBe(19);
		expect(written.spec_eval.requirements.iteration).toBe(1);
		expect(written.spec_eval.requirements.forced_progress).toBe(false);
	});

	it("forwards --forced-progress", () => {
		const code = runRecordSpecEval({
			phase: "tasks",
			total: "16",
			dim: '{"a":4,"b":4,"c":4,"d":4}',
			forcedProgress: true,
		});
		expect(code).toBe(0);
		const written = JSON.parse(readFileSync(statePath(), "utf8"));
		expect(written.spec_eval.tasks.forced_progress).toBe(true);
	});
});
