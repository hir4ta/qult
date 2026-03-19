import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGitCommit, isTestFailure, matchTaskDescription, detectWaveCompletion } from "../post-tool.js";
import { readStateJSON, writeWaveProgress } from "../state.js";
import type { ReviewGate } from "../review-gate.js";
import { readStateText, writeStateText } from "../state.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "post-tool-"));
	mkdirSync(join(tmpDir, ".alfred"), { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("explore count via state", () => {
	it("starts at 0", () => {
		const count = parseInt(readStateText(tmpDir, "explore-count", "0"), 10) || 0;
		expect(count).toBe(0);
	});

	it("increments correctly", () => {
		writeStateText(tmpDir, "explore-count", "1");
		const count = parseInt(readStateText(tmpDir, "explore-count", "0"), 10);
		expect(count).toBe(1);
	});

	it("resets to 0", () => {
		writeStateText(tmpDir, "explore-count", "5");
		writeStateText(tmpDir, "explore-count", "0");
		const count = parseInt(readStateText(tmpDir, "explore-count", "0"), 10);
		expect(count).toBe(0);
	});

	it("reaches threshold at 5", () => {
		for (let i = 1; i <= 5; i++) {
			writeStateText(tmpDir, "explore-count", String(i));
		}
		const count = parseInt(readStateText(tmpDir, "explore-count", "0"), 10);
		expect(count).toBe(5);
		expect(count >= 5).toBe(true);
	});
});

describe("isTestFailure", () => {
	it("detects FAIL", () => {
		expect(isTestFailure("FAIL src/test.ts")).toBe(true);
	});

	it("detects FAILED", () => {
		expect(isTestFailure("Tests FAILED")).toBe(true);
	});

	it("detects FAILURE", () => {
		expect(isTestFailure("FAILURE in test suite")).toBe(true);
	});

	it('detects "N failed"', () => {
		expect(isTestFailure("3 failed, 10 passed")).toBe(true);
	});

	it("does not detect passing tests", () => {
		expect(isTestFailure("All tests passed")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isTestFailure("")).toBe(false);
	});
});

describe("isGitCommit", () => {
	it("detects branch commit pattern", () => {
		expect(isGitCommit("[main abc1234] fix: something")).toBe(true);
	});

	it("detects feature branch commit", () => {
		expect(isGitCommit("[feature/login 1a2b3c4] feat: add login")).toBe(true);
	});

	it("detects diff stat pattern", () => {
		expect(isGitCommit("3 files changed, 100 insertions(+), 20 deletions(-)")).toBe(true);
	});

	it("does not detect regular output", () => {
		expect(isGitCommit("npm test completed successfully")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isGitCommit("")).toBe(false);
	});
});

describe("detectWaveCompletion", () => {
	it("emits DIRECTIVE and writes review-gate when wave completes (TS-1.3, TS-1.7)", () => {
		const content = `# Tasks: test

## Wave 1: Setup

- [x] T-1.1: First
- [x] T-1.2: Second

## Wave 2: Impl

- [ ] T-2.1: Third
`;
		const items = detectWaveCompletion(tmpDir, "test", content);
		expect(items.length).toBe(1);
		expect(items[0]!.level).toBe("DIRECTIVE");
		expect(items[0]!.message).toContain("Wave 1");
		expect(items[0]!.message).toContain("self-review");

		// Check review-gate.json was written
		const gate = readStateJSON<ReviewGate | null>(tmpDir, "review-gate.json", null);
		expect(gate).not.toBeNull();
		expect(gate!.gate).toBe("wave-review");
		expect(gate!.wave).toBe(1);
	});

	it("does not emit when wave is incomplete", () => {
		const content = `# Tasks: test

## Wave 1: Setup

- [x] T-1.1: First
- [ ] T-1.2: Second
`;
		const items = detectWaveCompletion(tmpDir, "test", content);
		expect(items.length).toBe(0);
	});

	it("does not emit for already-reviewed waves", () => {
		// Pre-populate wave-progress with reviewed=true
		writeWaveProgress(tmpDir, {
			slug: "test",
			current_wave: 2,
			waves: { "1": { total: 2, checked: 2, reviewed: true } },
		});

		const content = `# Tasks: test

## Wave 1: Setup

- [x] T-1.1: First
- [x] T-1.2: Second
`;
		const items = detectWaveCompletion(tmpDir, "test", content);
		expect(items.length).toBe(0);
	});

	it("sets review-gate for Closing Wave (FR-1: closing-wave-enforcement)", () => {
		const content = `# Tasks: test

## Wave: Closing

- [x] Self-review
- [x] Build check
`;
		const items = detectWaveCompletion(tmpDir, "test", content);
		expect(items.length).toBe(1);
		expect(items[0]!.level).toBe("DIRECTIVE");
		expect(items[0]!.message).toContain("self-review");

		// Check review-gate.json was written for closing wave
		const gate = readStateJSON<ReviewGate | null>(tmpDir, "review-gate.json", null);
		expect(gate).not.toBeNull();
		expect(gate!.gate).toBe("wave-review");
	});
});

describe("matchTaskDescription", () => {
	describe("file path matching (backtick-quoted)", () => {
		it("matches exact file path in backticks", () => {
			const desc = "T-1.1: Create `web/src/lib/i18n.tsx` — context, provider (FR-1)";
			expect(matchTaskDescription(desc, "/Users/dev/project/web/src/lib/i18n.tsx")).toBe(true);
		});

		it("matches file path case-insensitively", () => {
			const desc = "T-1.1: Create `src/hooks/Post-Tool.ts`";
			expect(matchTaskDescription(desc, "/path/to/src/hooks/post-tool.ts")).toBe(true);
		});

		it("does not match partial file name without extension", () => {
			const desc = "T-1.1: Update `README`";
			// No file extension in backticks → not treated as file path
			expect(matchTaskDescription(desc, "README")).toBe(false);
		});

		it("matches when multiple backtick paths, one matches", () => {
			const desc = "T-1.2: Update `main.tsx` and `app.tsx`";
			expect(matchTaskDescription(desc, "/project/src/main.tsx")).toBe(true);
		});
	});

	describe("word matching (adaptive threshold)", () => {
		it("matches with 2+ words for longer descriptions", () => {
			const desc = "T-1.3: Replace hardcoded strings in route files (FR-2)";
			expect(matchTaskDescription(desc, "replaced hardcoded strings in routes")).toBe(true);
		});

		it("matches with 40% threshold for longer descriptions", () => {
			const desc = "T-1.3: Replace hardcoded strings in route files (FR-2)";
			// 5 qualifying words: "t-1.3:", "replace", "hardcoded", "strings", "route", "files", "(fr-2)"
			// threshold = max(2, ceil(7*0.4)) = 3
			expect(matchTaskDescription(desc, "replaced hardcoded strings in routes")).toBe(true);
		});

		it("does not match unrelated content", () => {
			const desc = "T-1.1: Create i18n context provider with translations";
			expect(matchTaskDescription(desc, "git status\nnothing to commit")).toBe(false);
		});

		it("skips word matching when fewer than 2 qualifying words", () => {
			const desc = "T-1.1: Add new API for auth";
			// "Add", "new", "API", "for" are all <= 3 chars → only "t-1.1:" and "auth" qualify (2 words)
			// threshold = max(2, ceil(2*0.4)) = 2 → needs both
			expect(matchTaskDescription(desc, "auth endpoint added")).toBe(false);
		});
	});

	describe("filename partial match (Strategy 3, no backticks)", () => {
		it("matches filename in full file path", () => {
			const desc = "T-1.2: session-start.test.ts (新規)";
			expect(matchTaskDescription(desc, "/Users/dev/src/hooks/__tests__/session-start.test.ts")).toBe(true);
		});

		it("matches filename case-insensitively", () => {
			const desc = "T-1.3: Pre-Compact.test.ts 追加";
			expect(matchTaskDescription(desc, "/path/to/pre-compact.test.ts")).toBe(true);
		});

		it("matches multiple filenames, one matches", () => {
			const desc = "T-1.4: post-tool.test.ts拡張 + user-prompt.test.ts拡張";
			expect(matchTaskDescription(desc, "/path/to/post-tool.test.ts")).toBe(true);
		});

		it("does not match short filename-like strings", () => {
			const desc = "T-1.1: Fix a.ts";
			// "a.ts" is too short (4 chars, filtered by length > 4)
			expect(matchTaskDescription(desc, "/path/to/something.ts")).toBe(false);
		});

		it("matches vitest.config.ts in file path", () => {
			const desc = "T-1.1: vitest.config.ts coverage設定";
			expect(matchTaskDescription(desc, "/project/vitest.config.ts")).toBe(true);
		});

		it("does not match filename substring of another file", () => {
			const desc = "T-1.2: ledger.test.ts (新規)";
			// Should match ledger.test.ts but not knowledge-ledger.test.ts
			expect(matchTaskDescription(desc, "/path/to/ledger.test.ts")).toBe(true);
		});
	});

	describe("edge cases", () => {
		it("returns false for empty stdout", () => {
			expect(matchTaskDescription("T-1.1: Something", "")).toBe(false);
		});

		it("returns false for empty description", () => {
			expect(matchTaskDescription("", "some output")).toBe(false);
		});

		it("prefers file path match over word match", () => {
			const desc = "T-1.1: Create `src/foo.ts` — unrelated words here";
			expect(matchTaskDescription(desc, "src/foo.ts")).toBe(true);
		});
	});
});
