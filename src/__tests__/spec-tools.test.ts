import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleArchiveSpec,
	handleCompleteWave,
	handleGetActiveSpec,
	handleRecordSpecEvaluatorScore,
	handleUpdateTaskStatus,
	initWaveFile,
} from "../mcp-tools/spec-tools.ts";
import { setProjectRoot, wavePath } from "../state/paths.ts";

let tmpRoot: string;

function initRepo(root: string): void {
	execSync("git init -q", { cwd: root });
	execSync("git config user.email test@test", { cwd: root });
	execSync("git config user.name test", { cwd: root });
}

function commit(root: string, message: string): string {
	execSync("git add -A", { cwd: root });
	execSync(`git commit -q --allow-empty -m "${message}"`, { cwd: root });
	return execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
}

function mkTasksMd(root: string, specName: string, content: string): void {
	const dir = join(root, ".qult", "specs", specName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "tasks.md"), content);
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-spec-tools-"));
	mkdirSync(join(tmpRoot, ".qult", "specs"), { recursive: true });
	setProjectRoot(tmpRoot);
	initRepo(tmpRoot);
	process.chdir(tmpRoot);
});

afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("handleGetActiveSpec", () => {
	it("returns null when no spec exists", () => {
		const result = handleGetActiveSpec();
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed).toBeNull();
	});

	it("returns active spec metadata when one exists", () => {
		mkTasksMd(
			tmpRoot,
			"my-spec",
			"# Tasks: my-spec\n\n## Wave 1: scaffold\n\n- [ ] T1.1: foo\n- [x] T1.2: bar\n",
		);
		writeFileSync(join(tmpRoot, ".qult", "specs", "my-spec", "requirements.md"), "x");
		const result = handleGetActiveSpec();
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.name).toBe("my-spec");
		expect(parsed.has_requirements).toBe(true);
		expect(parsed.has_design).toBe(false);
		expect(parsed.has_tasks).toBe(true);
		expect(parsed.total_waves).toBe(1);
		expect(parsed.current_wave).toBe(1);
		expect(parsed.task_summary.pending).toBe(1);
		expect(parsed.task_summary.done).toBe(1);
	});
});

describe("handleUpdateTaskStatus", () => {
	beforeEach(() => {
		mkTasksMd(
			tmpRoot,
			"my-spec",
			"# Tasks: my-spec\n\n## Wave 1: x\n\n- [ ] T1.1: foo\n- [ ] T1.2: bar\n",
		);
	});

	it("flips task status and persists", () => {
		const result = handleUpdateTaskStatus({ task_id: "T1.1", status: "done" });
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.ok).toBe(true);

		const after = handleGetActiveSpec();
		const ap = JSON.parse(after.content[0]!.text);
		expect(ap.task_summary.done).toBe(1);
	});

	it("returns task_not_found for unknown id (NOT silent no-op)", () => {
		const result = handleUpdateTaskStatus({ task_id: "T9.99", status: "done" });
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.ok).toBe(false);
		expect(parsed.reason).toBe("task_not_found");
	});

	it("rejects invalid status", () => {
		const result = handleUpdateTaskStatus({ task_id: "T1.1", status: "weird" });
		expect(result.isError).toBe(true);
	});
});

describe("handleCompleteWave", () => {
	beforeEach(() => {
		mkdirSync(join(tmpRoot, ".qult", "specs", "my-spec"), { recursive: true });
	});

	it("rejects when no wave file exists", () => {
		const sha = commit(tmpRoot, "init");
		const result = handleCompleteWave({
			wave_num: 1,
			commit_range: `${sha}..${sha}`,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toMatch(/wave-01\.md not found/);
	});

	it("finalizes a wave with valid range", () => {
		const sha = commit(tmpRoot, "init");
		initWaveFile({
			specName: "my-spec",
			waveNum: 1,
			title: "scaffold",
			goal: "g",
			verify: "v",
			scaffold: true,
		});
		const result = handleCompleteWave({
			wave_num: 1,
			commit_range: `${sha}..${sha}`,
		});
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.ok).toBe(true);
		expect(parsed.range).toBe(`${sha}..${sha}`);
	});

	it("returns already_completed on second call (idempotent)", () => {
		const sha = commit(tmpRoot, "init");
		initWaveFile({ specName: "my-spec", waveNum: 1, title: "x", goal: "g", verify: "v" });
		handleCompleteWave({ wave_num: 1, commit_range: `${sha}..${sha}` });
		const second = handleCompleteWave({ wave_num: 1, commit_range: `${sha}..${sha}` });
		const parsed = JSON.parse(second.content[0]!.text);
		expect(parsed.ok).toBe(false);
		expect(parsed.reason).toBe("already_completed");
	});

	it("rejects malformed commit_range", () => {
		commit(tmpRoot, "init");
		initWaveFile({ specName: "my-spec", waveNum: 1, title: "x", goal: "g", verify: "v" });
		const r = handleCompleteWave({ wave_num: 1, commit_range: "not-a-range" });
		expect(r.isError).toBe(true);
	});

	it("detects sha_unreachable when prior wave's range is rebased away", () => {
		const sha1 = commit(tmpRoot, "first");
		// Wave 1 with valid range
		initWaveFile({ specName: "my-spec", waveNum: 1, title: "x", goal: "g", verify: "v" });
		handleCompleteWave({ wave_num: 1, commit_range: `${sha1}..${sha1}` });

		// Rewrite wave-01.md to claim a fake unreachable SHA
		writeFileSync(
			wavePath("my-spec", 1),
			[
				"# Wave 1: x",
				"",
				"**Goal**: g",
				"**Verify**: v",
				"**Started at**: 2026-04-25T00:00:00Z",
				"**Completed at**: 2026-04-25T00:30:00Z",
				"**Scaffold**: false",
				"",
				"## Commits",
				"- 0000000: bogus",
				"",
				"**Range**: 0000000000000000000000000000000000000000..0000000000000000000000000000000000000000",
				"",
				"## Notes",
				"",
			].join("\n"),
		);

		// Try to complete Wave 2 — should detect stale wave-01
		commit(tmpRoot, "second");
		initWaveFile({ specName: "my-spec", waveNum: 2, title: "y", goal: "g", verify: "v" });
		const head = execSync("git rev-parse HEAD", { cwd: tmpRoot }).toString().trim();
		const result = handleCompleteWave({ wave_num: 2, commit_range: `${head}..${head}` });
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.ok).toBe(false);
		expect(parsed.reason).toBe("sha_unreachable");
		expect(parsed.stale).toContain("wave-01");
	});
});

describe("handleArchiveSpec", () => {
	it("moves the spec dir under archive/", () => {
		mkdirSync(join(tmpRoot, ".qult", "specs", "demo"), { recursive: true });
		writeFileSync(join(tmpRoot, ".qult", "specs", "demo", "requirements.md"), "x");
		const result = handleArchiveSpec({ spec_name: "demo" });
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.ok).toBe(true);
		expect(parsed.archived_to).toContain("/archive/demo");
	});

	it("rejects reserved name 'archive'", () => {
		const result = handleArchiveSpec({ spec_name: "archive" });
		expect(result.isError).toBe(true);
	});

	it("rejects path traversal via spec_name", () => {
		const result = handleArchiveSpec({ spec_name: "../etc" });
		expect(result.isError).toBe(true);
	});
});

describe("handleRecordSpecEvaluatorScore", () => {
	it("records a phase score", () => {
		const result = handleRecordSpecEvaluatorScore({
			phase: "requirements",
			total: 18,
			dim_scores: { completeness: 5, testability: 4, unambiguity: 5, feasibility: 4 },
			forced_progress: false,
			iteration: 1,
		});
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.ok).toBe(true);
		expect(parsed.recorded.total).toBe(18);
	});

	it("rejects invalid phase", () => {
		const r = handleRecordSpecEvaluatorScore({
			phase: "not-a-phase",
			total: 18,
			dim_scores: {},
		});
		expect(r.isError).toBe(true);
	});

	it("rejects out-of-range total", () => {
		const r = handleRecordSpecEvaluatorScore({
			phase: "requirements",
			total: 99,
			dim_scores: {},
		});
		expect(r.isError).toBe(true);
	});
});
