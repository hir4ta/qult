/**
 * Wave 3 component tests. Goal is verify each panel renders the data the
 * reducer feeds it and that key labels appear in the output frame. We are
 * not pixel-snapshotting — `lastFrame()` substring checks are robust to
 * theme tweaks while still catching regressions.
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { DetectorPanel } from "../../dashboard/components/DetectorPanel.tsx";
import { EmptyState } from "../../dashboard/components/EmptyState.tsx";
import { EventLog } from "../../dashboard/components/EventLog.tsx";
import { Header } from "../../dashboard/components/Header.tsx";
import { ReviewPanel } from "../../dashboard/components/ReviewPanel.tsx";
import { WavePanel } from "../../dashboard/components/WavePanel.tsx";
import {
	ALL_DETECTOR_IDS,
	type DashboardEvent,
	REVIEW_THRESHOLD_DEFAULT,
	type ReviewStageSummary,
	type WaveSummary,
} from "../../dashboard/types.ts";

describe("Header", () => {
	it("shows version and 'no active spec' when null", () => {
		const { lastFrame } = render(<Header version="1.2.3" activeSpec={null} columns={120} />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("v1.2.3");
		expect(frame).toContain("no active spec");
	});

	it("shows spec name + phase Badge when active", () => {
		const { lastFrame } = render(
			<Header
				version="1.2.3"
				activeSpec={{ name: "alpha", phase: "implementation" }}
				columns={120}
			/>,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("alpha");
		expect(frame.toLowerCase()).toContain("implementation");
	});
});

describe("WavePanel", () => {
	it("renders Spinner-fallback when no waves yet", () => {
		const { lastFrame } = render(<WavePanel waves={[]} />);
		expect(lastFrame()).toContain("awaiting waves");
	});

	it("renders rows with status and progress", () => {
		const waves: WaveSummary[] = [
			{
				number: 1,
				title: "first",
				status: "done",
				tasksDone: 3,
				tasksTotal: 3,
				startedAt: null,
				completedAt: null,
			},
			{
				number: 2,
				title: "second",
				status: "in-progress",
				tasksDone: 1,
				tasksTotal: 4,
				startedAt: null,
				completedAt: null,
			},
		];
		const frame = (render(<WavePanel waves={waves} />).lastFrame() ?? "").toLowerCase();
		expect(frame).toContain("#01");
		expect(frame).toContain("done");
		expect(frame).toContain("#02");
		expect(frame).toContain("in-progress");
		expect(frame).toContain("100%");
		expect(frame).toContain("25%");
	});
});

describe("DetectorPanel", () => {
	it("lists all five detectors with counts", () => {
		const detectors = ALL_DETECTOR_IDS.map((id, i) => ({
			id,
			status: i === 0 ? ("fail" as const) : ("never-run" as const),
			pendingFixes: i === 0 ? 2 : 0,
			lastRunAt: null,
		}));
		const frame = render(<DetectorPanel detectors={detectors} />).lastFrame() ?? "";
		for (const id of ALL_DETECTOR_IDS) expect(frame).toContain(id);
		expect(frame).toContain("2 fixes");
		expect(frame).toContain("pending fixes");
	});
});

describe("ReviewPanel", () => {
	it("renders all four stages with scores", () => {
		const reviews: ReviewStageSummary = {
			spec: { score: 19, threshold: REVIEW_THRESHOLD_DEFAULT, passed: true },
			quality: { score: 16, threshold: REVIEW_THRESHOLD_DEFAULT, passed: false },
			security: { score: null, threshold: REVIEW_THRESHOLD_DEFAULT, passed: null },
			adversarial: { score: null, threshold: REVIEW_THRESHOLD_DEFAULT, passed: null },
		};
		const rawFrame = render(<ReviewPanel reviews={reviews} />).lastFrame() ?? "";
		const frame = rawFrame.toLowerCase();
		for (const label of ["spec", "quality", "security", "adversarial"]) {
			expect(frame).toContain(label);
		}
		expect(frame).toContain("19/20");
		expect(frame).toContain("16/20");
		expect(frame).toContain("pending");
		expect(frame).toContain("pass");
		expect(frame).toContain("below");
	});
});

describe("EventLog", () => {
	it("renders an idle hint when empty", () => {
		const frame = render(<EventLog events={[]} maxLines={5} />).lastFrame() ?? "";
		expect(frame).toContain("idle");
	});

	it("renders newest events first, capped to maxLines", () => {
		const events: DashboardEvent[] = Array.from({ length: 5 }, (_, i) => ({
			id: `e${i}`,
			ts: 1_700_000_000_000 + i * 1000,
			kind: "review",
			variant: "info",
			message: `msg-${i}`,
		}));
		const frame = render(<EventLog events={events} maxLines={3} />).lastFrame() ?? "";
		// Newest at top.
		const idx4 = frame.indexOf("msg-4");
		const idx2 = frame.indexOf("msg-2");
		expect(idx4).toBeGreaterThanOrEqual(0);
		expect(idx2).toBeGreaterThan(idx4);
		// Overflow trimmed.
		expect(frame).not.toContain("msg-1");
	});
});

describe("EmptyState", () => {
	it("renders the waiting message and example command", () => {
		const frame = render(<EmptyState />).lastFrame() ?? "";
		expect(frame).toContain("waiting for an active spec");
		expect(frame).toContain("/qult:spec");
	});
});
