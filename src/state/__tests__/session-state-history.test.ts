import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureSession, setProjectPath, setSessionScope, useTestDb } from "../db.ts";
import { resetAllCaches } from "../flush.ts";
import {
	clearOnCommit,
	getPlanEvalScoreHistory,
	getReviewIteration,
	getReviewScoreHistory,
	readSessionState,
	recordPlanEvalIteration,
	recordReviewIteration,
	resetPlanEvalIteration,
	resetReviewIteration,
} from "../session-state.ts";

const TEST_DIR = "/tmp/.tmp-history";

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	resetAllCaches();
});

afterEach(() => {
	closeDb();
});

describe("review score history", () => {
	it("pushes scores and tracks iteration count", () => {
		recordReviewIteration(9);
		expect(getReviewIteration()).toBe(1);
		expect(getReviewScoreHistory()).toEqual([9]);

		recordReviewIteration(11);
		expect(getReviewIteration()).toBe(2);
		expect(getReviewScoreHistory()).toEqual([9, 11]);

		recordReviewIteration(13);
		expect(getReviewIteration()).toBe(3);
		expect(getReviewScoreHistory()).toEqual([9, 11, 13]);
	});

	it("resets history on resetReviewIteration", () => {
		recordReviewIteration(9);
		recordReviewIteration(10);
		resetReviewIteration();

		expect(getReviewIteration()).toBe(0);
		expect(getReviewScoreHistory()).toEqual([]);
	});

	it("resets history on clearOnCommit", () => {
		recordReviewIteration(9);
		clearOnCommit();

		expect(getReviewScoreHistory()).toEqual([]);
		const state = readSessionState();
		expect(state.review_iteration).toBe(0);
	});
});

describe("plan eval score history", () => {
	it("pushes scores and resets", () => {
		recordPlanEvalIteration(8);
		recordPlanEvalIteration(10);
		expect(getPlanEvalScoreHistory()).toEqual([8, 10]);

		resetPlanEvalIteration();
		expect(getPlanEvalScoreHistory()).toEqual([]);
	});
});
