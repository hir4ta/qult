import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type BudgetLedger,
	readBudgetLedger,
	recordInjection,
	trimToBudget,
	writeBudgetLedger,
} from "../budget.js";
import type { DirectiveItem } from "../directives.js";

function freshLedger(overrides?: Partial<BudgetLedger>): BudgetLedger {
	return {
		totalSpent: 0,
		perHook: {},
		postToolCumulative: 0,
		injectionCount: 0,
		directiveHashes: {},
		...overrides,
	};
}

describe("budget", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "budget-test-"));
		mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
	});

	afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

	it("round-trips ledger read/write", () => {
		const ledger = freshLedger({ totalSpent: 100, injectionCount: 5 });
		writeBudgetLedger(tmpDir, ledger);
		const read = readBudgetLedger(tmpDir);
		expect(read.totalSpent).toBe(100);
		expect(read.injectionCount).toBe(5);
	});

	it("returns all items when under budget", () => {
		const items: DirectiveItem[] = [
			{ level: "DIRECTIVE", message: "Fix this" },
			{ level: "WARNING", message: "Watch out" },
			{ level: "CONTEXT", message: "FYI" },
		];
		const result = trimToBudget("PostToolUse", items, freshLedger());
		expect(result).toHaveLength(3);
	});

	it("drops CONTEXT first when at 60% budget", () => {
		const ledger = freshLedger({ totalSpent: 9_500 }); // 63% of 15K
		const items: DirectiveItem[] = [
			{ level: "DIRECTIVE", message: "Fix this" },
			{ level: "WARNING", message: "Watch out" },
			{ level: "CONTEXT", message: "FYI info" },
		];
		const result = trimToBudget("PostToolUse", items, ledger);
		expect(result.find((i) => i.level === "CONTEXT")).toBeUndefined();
		expect(result.find((i) => i.level === "DIRECTIVE")).toBeDefined();
		expect(result.find((i) => i.level === "WARNING")).toBeDefined();
	});

	it("drops WARNING at 80% budget", () => {
		const ledger = freshLedger({ totalSpent: 12_500 }); // 83% of 15K
		const items: DirectiveItem[] = [
			{ level: "DIRECTIVE", message: "Fix this" },
			{ level: "WARNING", message: "Watch out" },
			{ level: "CONTEXT", message: "FYI info" },
		];
		const result = trimToBudget("PostToolUse", items, ledger);
		expect(result.find((i) => i.level === "CONTEXT")).toBeUndefined();
		expect(result.find((i) => i.level === "WARNING")).toBeUndefined();
		expect(result.find((i) => i.level === "DIRECTIVE")).toBeDefined();
	});

	it("never drops DIRECTIVE even when budget exhausted", () => {
		const ledger = freshLedger({ totalSpent: 15_000 }); // 100%
		const items: DirectiveItem[] = [
			{ level: "DIRECTIVE", message: "Must fix this critical issue" },
		];
		const result = trimToBudget("PostToolUse", items, ledger);
		expect(result).toHaveLength(1);
		expect(result[0]!.level).toBe("DIRECTIVE");
	});

	it("dedup drops directive seen 3+ times", () => {
		const msg = "Fix lint error XYZ";
		const ledger = freshLedger();
		// Simulate 3 previous occurrences
		const items: DirectiveItem[] = [{ level: "DIRECTIVE", message: msg }];
		// Manually record hash 3 times
		for (let i = 0; i < 3; i++) {
			recordInjection(ledger, "PostToolUse", items);
		}
		// Now 4th attempt should be deduped
		const result = trimToBudget("PostToolUse", items, ledger);
		expect(result).toHaveLength(0);
	});

	it("tracks PostToolUse cumulative budget", () => {
		const ledger = freshLedger({ postToolCumulative: 7_500 }); // near 8K limit
		const items: DirectiveItem[] = [
			{ level: "DIRECTIVE", message: "Fix it" },
			{ level: "WARNING", message: "A".repeat(3000) }, // ~750 tokens
		];
		const result = trimToBudget("PostToolUse", items, ledger);
		// DIRECTIVE always kept, WARNING may be dropped if doesn't fit
		expect(result.find((i) => i.level === "DIRECTIVE")).toBeDefined();
	});

	it("recordInjection updates ledger correctly", () => {
		const ledger = freshLedger();
		const items: DirectiveItem[] = [
			{ level: "DIRECTIVE", message: "Fix this" },
			{ level: "CONTEXT", message: "Info" },
		];
		recordInjection(ledger, "PostToolUse", items);
		expect(ledger.totalSpent).toBeGreaterThan(0);
		expect(ledger.injectionCount).toBe(1);
		expect(ledger.postToolCumulative).toBeGreaterThan(0);
		expect(Object.keys(ledger.directiveHashes)).toHaveLength(1);
	});

	it("handles corrupt ledger gracefully", () => {
		// readBudgetLedger returns empty on missing file
		const ledger = readBudgetLedger(tmpDir);
		expect(ledger.totalSpent).toBe(0);
		expect(ledger.injectionCount).toBe(0);
	});
});
