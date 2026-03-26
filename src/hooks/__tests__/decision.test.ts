import { describe, expect, it } from "vitest";
import { extractCommitMessage, isPlanFile } from "../detect.js";

describe("isPlanFile", () => {
	it("detects .claude/plans/ files", () => {
		expect(isPlanFile("/Users/foo/.claude/plans/my-plan.md")).toBe(true);
		expect(isPlanFile("/home/user/.claude/plans/lovely-stargazing-papert.md")).toBe(true);
	});

	it("detects plan*.md files", () => {
		expect(isPlanFile("/project/plan.md")).toBe(true);
		expect(isPlanFile("/project/plan-v2.md")).toBe(true);
		expect(isPlanFile("/project/PLAN.md")).toBe(true);
	});

	it("rejects non-plan files", () => {
		expect(isPlanFile("/project/src/foo.ts")).toBe(false);
		expect(isPlanFile("/project/README.md")).toBe(false);
		expect(isPlanFile("/project/explanation.md")).toBe(false);
	});
});

describe("extractCommitMessage", () => {
	it("extracts commit message from git output", () => {
		const msg = extractCommitMessage(
			"[main abc1234] feat: implement knowledge auto-accumulation engine for better quality",
		);
		expect(msg).toBe("feat: implement knowledge auto-accumulation engine for better quality");
	});

	it("returns null for short commit messages", () => {
		const msg = extractCommitMessage("[main abc1234] fix typo");
		expect(msg).toBeNull();
	});

	it("returns null for non-commit output", () => {
		expect(extractCommitMessage("hello world")).toBeNull();
		expect(extractCommitMessage("")).toBeNull();
	});
});
