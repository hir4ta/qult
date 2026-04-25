import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendPendingFix,
	clearPendingFixes,
	hasHighSeverityFix,
	patchCurrent,
	readCurrent,
	readPendingFixes,
	readStageScores,
	recordReviewStage,
	recordSpecEvalPhase,
	resetSpecEval,
} from "../state/json-state.ts";
import { setProjectRoot } from "../state/paths.ts";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-json-"));
	mkdirSync(join(tmpRoot, ".qult"), { recursive: true });
	setProjectRoot(tmpRoot);
});

afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("current.json", () => {
	it("returns defaults on empty state", () => {
		const cur = readCurrent();
		expect(cur.test_passed_at).toBeNull();
		expect(cur.review_completed_at).toBeNull();
		expect(cur.last_active_wave).toBeNull();
	});

	it("patches and persists", () => {
		patchCurrent({ test_passed_at: "2026-04-25T00:00:00Z", test_command: "bun test" });
		const cur = readCurrent();
		expect(cur.test_passed_at).toBe("2026-04-25T00:00:00Z");
		expect(cur.test_command).toBe("bun test");
		patchCurrent({ review_completed_at: "2026-04-25T01:00:00Z", review_score: 32 });
		const after = readCurrent();
		expect(after.test_passed_at).toBe("2026-04-25T00:00:00Z"); // preserved
		expect(after.review_score).toBe(32);
	});
});

describe("pending-fixes.json", () => {
	const baseFix = (sev: "low" | "medium" | "high" | "critical") => ({
		id: `fix-${sev}`,
		detector: "security-check",
		severity: sev,
		file: "src/x.ts",
		line: 1,
		message: "test",
		created_at: "2026-04-25T00:00:00Z",
	});

	it("starts empty", () => {
		expect(readPendingFixes().fixes).toEqual([]);
	});

	it("appends fixes and detects high severity", () => {
		appendPendingFix(baseFix("low"));
		expect(hasHighSeverityFix(readPendingFixes())).toBe(false);
		appendPendingFix(baseFix("high"));
		expect(hasHighSeverityFix(readPendingFixes())).toBe(true);
	});

	it("treats critical as blocking", () => {
		appendPendingFix(baseFix("critical"));
		expect(hasHighSeverityFix(readPendingFixes())).toBe(true);
	});

	it("clearPendingFixes empties the list", () => {
		appendPendingFix(baseFix("medium"));
		expect(readPendingFixes().fixes).toHaveLength(1);
		clearPendingFixes();
		expect(readPendingFixes().fixes).toEqual([]);
	});
});

describe("stage-scores.json", () => {
	it("starts with all stages null", () => {
		const s = readStageScores();
		expect(s.review.Spec).toBeNull();
		expect(s.spec_eval.requirements).toBeNull();
	});

	it("records review stages independently", () => {
		recordReviewStage("Spec", { completeness: 4, accuracy: 4 });
		recordReviewStage("Quality", { design: 5, maintainability: 4 });
		const s = readStageScores();
		expect(s.review.Spec?.scores).toEqual({ completeness: 4, accuracy: 4 });
		expect(s.review.Quality?.scores).toEqual({ design: 5, maintainability: 4 });
		expect(s.review.Security).toBeNull(); // untouched
	});

	it("records spec_eval phases with forced_progress flag", () => {
		recordSpecEvalPhase("requirements", {
			total: 18,
			dim_scores: { completeness: 5, testability: 4, unambiguity: 5, feasibility: 4 },
			forced_progress: false,
			iteration: 1,
		});
		const s = readStageScores();
		expect(s.spec_eval.requirements?.total).toBe(18);
		expect(s.spec_eval.requirements?.forced_progress).toBe(false);
	});

	it("resetSpecEval clears prior spec scores but keeps review history", () => {
		recordReviewStage("Spec", { completeness: 4, accuracy: 4 });
		recordSpecEvalPhase("requirements", {
			total: 20,
			dim_scores: {},
			forced_progress: false,
			iteration: 1,
		});
		resetSpecEval("new-spec");
		const s = readStageScores();
		expect(s.spec_name).toBe("new-spec");
		expect(s.spec_eval.requirements).toBeNull();
		expect(s.review.Spec?.scores).toEqual({ completeness: 4, accuracy: 4 });
	});
});
