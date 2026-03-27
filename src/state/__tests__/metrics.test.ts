import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAllCaches } from "../flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-metrics-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("metrics", () => {
	it("records actions and reads them back", async () => {
		const { recordAction, readMetrics } = await import("../metrics.ts");
		recordAction("pre-tool", "deny", "pending-fixes exist");
		recordAction("stop", "block", "plan incomplete");
		recordAction("post-tool", "respond", "lint errors found");

		const entries = readMetrics();
		expect(entries).toHaveLength(3);
		expect(entries[0]!.action).toBe("pre-tool:deny");
		expect(entries[0]!.reason).toBe("pending-fixes exist");
		expect(entries[2]!.action).toBe("post-tool:respond");
	});

	it("caps at 500 entries", async () => {
		const { recordAction, readMetrics } = await import("../metrics.ts");
		for (let i = 0; i < 510; i++) {
			recordAction("post-tool", "respond", `error-${i}`);
		}

		const entries = readMetrics();
		expect(entries).toHaveLength(500);
		// Oldest entries should be trimmed
		expect(entries[0]!.reason).toBe("error-10");
	});

	it("returns summary counts by action", async () => {
		const { recordAction, getMetricsSummary } = await import("../metrics.ts");
		recordAction("pre-tool", "deny", "pending-fixes");
		recordAction("pre-tool", "deny", "pace red");
		recordAction("pre-tool", "deny", "pending-fixes");
		recordAction("stop", "block", "plan incomplete");
		recordAction("post-tool", "respond", "lint errors");

		const summary = getMetricsSummary();
		expect(summary.deny).toBe(3);
		expect(summary.block).toBe(1);
		expect(summary.respond).toBe(1);
		expect(summary.topReasons).toHaveLength(4);
		expect(summary.topReasons[0]!.reason).toBe("pending-fixes");
		expect(summary.topReasons[0]!.count).toBe(2);
	});

	it("returns empty summary when no metrics", async () => {
		const { getMetricsSummary } = await import("../metrics.ts");
		const summary = getMetricsSummary();
		expect(summary.deny).toBe(0);
		expect(summary.block).toBe(0);
		expect(summary.respond).toBe(0);
		expect(summary.gatePassRate).toBe(0);
		expect(summary.respondSkipped).toBe(0);
		expect(summary.topReasons).toHaveLength(0);
	});

	it("records gate outcomes and computes pass rate", async () => {
		const { recordGateOutcome, getMetricsSummary } = await import("../metrics.ts");
		recordGateOutcome("lint", true);
		recordGateOutcome("typecheck", true);
		recordGateOutcome("lint", false);
		recordGateOutcome("lint", true);

		const summary = getMetricsSummary();
		expect(summary.gatePassRate).toBe(75); // 3 pass / 4 total
	});

	it("tracks respond-skipped in summary", async () => {
		const { recordAction, getMetricsSummary } = await import("../metrics.ts");
		recordAction("post-tool", "respond-skipped", "budget exceeded");
		recordAction("session-start", "respond-skipped", "budget exceeded");

		const summary = getMetricsSummary();
		expect(summary.respondSkipped).toBe(2);
	});

	it("records first-pass outcomes and computes clean rate", async () => {
		const { recordFirstPass, getMetricsSummary } = await import("../metrics.ts");
		recordFirstPass(true);
		recordFirstPass(true);
		recordFirstPass(false);
		recordFirstPass(true);

		const summary = getMetricsSummary();
		expect(summary.firstPassRate).toBe(75); // 3 clean / 4 total
	});

	it("records review outcomes and computes pass rate", async () => {
		const { recordReviewOutcome, getMetricsSummary } = await import("../metrics.ts");
		recordReviewOutcome(true);
		recordReviewOutcome(false);
		recordReviewOutcome(true);

		const summary = getMetricsSummary();
		expect(summary.reviewPassRate).toBe(67); // 2 pass / 3 total
	});
});
