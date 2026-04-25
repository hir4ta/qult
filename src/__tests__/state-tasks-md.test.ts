import { describe, expect, it } from "vitest";
import {
	findNextIncompleteWave,
	listTaskIds,
	parseTasksMd,
	setTaskStatus,
	summarizeTaskStatus,
	TaskNotFoundError,
} from "../state/tasks-md.ts";

const SAMPLE = `# Tasks: my-spec

## Wave 1: scaffold

**Goal**: bootstrap
**Verify**: build green
**Scaffold**: true

- [ ] T1.1: paths
- [x] T1.2: fs
- [~] T1.3: parser
- [!] T1.4: blocked thing

## Wave 2: core

**Goal**: implement
**Verify**: tests

- [ ] T2.1: thing
- [ ] T2.2: other
`;

describe("parseTasksMd", () => {
	it("extracts spec name and Waves", () => {
		const doc = parseTasksMd(SAMPLE);
		expect(doc.specName).toBe("my-spec");
		expect(doc.waves).toHaveLength(2);
		expect(doc.waves[0]?.num).toBe(1);
		expect(doc.waves[0]?.title).toBe("scaffold");
		expect(doc.waves[0]?.scaffold).toBe(true);
		expect(doc.waves[1]?.scaffold).toBe(false);
	});

	it("parses task statuses", () => {
		const doc = parseTasksMd(SAMPLE);
		const w1 = doc.waves[0];
		expect(w1?.tasks).toHaveLength(4);
		expect(w1?.tasks[0]).toEqual({ id: "T1.1", title: "paths", status: "pending" });
		expect(w1?.tasks[1]?.status).toBe("done");
		expect(w1?.tasks[2]?.status).toBe("in_progress");
		expect(w1?.tasks[3]?.status).toBe("blocked");
	});

	it("rejects task title with control chars", () => {
		const bad = "## Wave 1: x\n\n- [ ] T1.1: badtitle\n";
		expect(() => parseTasksMd(bad)).toThrow(/control characters/);
	});

	it("rejects task title exceeding 1024 chars", () => {
		const longTitle = "x".repeat(1025);
		const bad = `## Wave 1: x\n\n- [ ] T1.1: ${longTitle}\n`;
		expect(() => parseTasksMd(bad)).toThrow(/exceeds/);
	});
});

describe("setTaskStatus", () => {
	it("flips status preserving everything else", () => {
		const out = setTaskStatus(SAMPLE, "T1.1", "done");
		expect(out).toContain("- [x] T1.1: paths");
		expect(out).toContain("- [x] T1.2: fs"); // unchanged
		// length sanity
		expect(out.length).toBe(SAMPLE.length);
	});

	it("can move status backwards (done → in_progress)", () => {
		const out = setTaskStatus(SAMPLE, "T1.2", "in_progress");
		expect(out).toContain("- [~] T1.2: fs");
	});

	it("throws TaskNotFoundError for unknown id", () => {
		expect(() => setTaskStatus(SAMPLE, "T9.99", "done")).toThrow(TaskNotFoundError);
		try {
			setTaskStatus(SAMPLE, "T9.99", "done");
		} catch (err) {
			expect((err as TaskNotFoundError).taskId).toBe("T9.99");
		}
	});

	it("round-trips through parseTasksMd", () => {
		const out = setTaskStatus(SAMPLE, "T2.1", "done");
		const doc = parseTasksMd(out);
		const t = doc.waves.find((w) => w.num === 2)?.tasks.find((t) => t.id === "T2.1");
		expect(t?.status).toBe("done");
	});
});

describe("listTaskIds + summarizeTaskStatus", () => {
	it("returns all task ids in order", () => {
		expect(listTaskIds(SAMPLE)).toEqual(["T1.1", "T1.2", "T1.3", "T1.4", "T2.1", "T2.2"]);
	});

	it("summarizes counts by status", () => {
		const counts = summarizeTaskStatus(parseTasksMd(SAMPLE));
		expect(counts.pending).toBe(3);
		expect(counts.done).toBe(1);
		expect(counts.in_progress).toBe(1);
		expect(counts.blocked).toBe(1);
	});
});

describe("findNextIncompleteWave", () => {
	it("returns the first Wave with non-done tasks", () => {
		const next = findNextIncompleteWave(parseTasksMd(SAMPLE));
		expect(next?.num).toBe(1);
	});

	it("returns null when all done", () => {
		const allDone = SAMPLE.replace(/- \[ \]/g, "- [x]")
			.replace(/- \[~\]/g, "- [x]")
			.replace(/- \[!\]/g, "- [x]");
		expect(findNextIncompleteWave(parseTasksMd(allDone))).toBeNull();
	});
});
