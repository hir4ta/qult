import { describe, expect, it } from "vitest";
import { newWaveDoc, parseWaveMd, writeWaveMd } from "../state/wave-md.ts";

describe("parseWaveMd", () => {
	it("parses a complete wave-NN.md", () => {
		const md = `# Wave 2: core implementation

**Goal**: implement the core
**Verify**: tests pass
**Started at**: 2026-04-25T15:00:00Z
**Completed at**: 2026-04-25T16:30:00Z
**Scaffold**: false
**Fixes**: wave-01

## Commits
- abc1234: feat: thing
- def5678: test: cover

**Range**: abc1234..def5678

## Notes

implementation note
`;
		const doc = parseWaveMd(md);
		expect(doc.num).toBe(2);
		expect(doc.title).toBe("core implementation");
		expect(doc.goal).toBe("implement the core");
		expect(doc.verify).toBe("tests pass");
		expect(doc.startedAt).toBe("2026-04-25T15:00:00Z");
		expect(doc.completedAt).toBe("2026-04-25T16:30:00Z");
		expect(doc.scaffold).toBe(false);
		expect(doc.fixes).toBe(1);
		expect(doc.commits).toEqual([
			{ sha: "abc1234", subject: "feat: thing" },
			{ sha: "def5678", subject: "test: cover" },
		]);
		expect(doc.range).toBe("abc1234..def5678");
		expect(doc.notes).toBe("implementation note");
	});

	it("tolerates missing optional fields", () => {
		const md = `# Wave 1: scaffold

**Goal**: bootstrap
**Verify**: build green
**Scaffold**: true
`;
		const doc = parseWaveMd(md);
		expect(doc.startedAt).toBeNull();
		expect(doc.completedAt).toBeNull();
		expect(doc.fixes).toBeNull();
		expect(doc.supersededBy).toBeNull();
		expect(doc.commits).toEqual([]);
		expect(doc.range).toBeNull();
		expect(doc.scaffold).toBe(true);
	});
});

describe("writeWaveMd round-trip", () => {
	it("emits canonical markdown that re-parses identically (modulo trivia)", () => {
		const doc = newWaveDoc({
			num: 3,
			title: "feature x",
			goal: "do x",
			verify: "x works",
			startedAt: "2026-04-25T10:00:00Z",
		});
		doc.commits = [{ sha: "1234abc", subject: "feat: x" }];
		doc.range = "1234abc..5678def";
		doc.completedAt = "2026-04-25T11:00:00Z";

		const out = writeWaveMd(doc);
		const parsed = parseWaveMd(out);
		expect(parsed.num).toBe(3);
		expect(parsed.title).toBe("feature x");
		expect(parsed.goal).toBe("do x");
		expect(parsed.commits).toEqual(doc.commits);
		expect(parsed.range).toBe("1234abc..5678def");
		expect(parsed.completedAt).toBe("2026-04-25T11:00:00Z");
	});

	it("includes Fixes / Superseded by when set", () => {
		const doc = newWaveDoc({
			num: 6,
			title: "fix wave 2",
			goal: "fix",
			verify: "v",
			startedAt: "2026-04-25T12:00:00Z",
			fixes: 2,
		});
		doc.supersededBy = 7;
		const out = writeWaveMd(doc);
		expect(out).toContain("**Fixes**: wave-02");
		expect(out).toContain("**Superseded by**: wave-07");
	});
});
