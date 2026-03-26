import { describe, expect, it } from "vitest";
import {
	buildReflectionDirective,
	classifyTaskType,
	determineDepth,
	getReflectionTemplate,
} from "../reflection.js";

describe("reflection", () => {
	describe("classifyTaskType", () => {
		it("detects bug_fix from 'fix' in file names", () => {
			expect(classifyTaskType(["fix-auth.ts"])).toBe("bug_fix");
		});
		it("detects refactor from 'refactor' in file names", () => {
			expect(classifyTaskType(["refactor-db.ts"])).toBe("refactor");
		});
		it("detects new_feature for non-test source files", () => {
			expect(classifyTaskType(["src/new-module.ts"])).toBe("new_feature");
		});
		it("returns unknown for test-only changes", () => {
			expect(classifyTaskType(["test/spec/helpers.test.ts"])).toBe("unknown");
		});
	});

	describe("determineDepth", () => {
		it("returns light for <=10 lines, 1 file, no new files", () => {
			expect(determineDepth(5, 1, false)).toBe("light");
		});
		it("returns standard for moderate changes", () => {
			expect(determineDepth(50, 3, false)).toBe("standard");
		});
		it("returns deep for 5+ files", () => {
			expect(determineDepth(100, 5, false)).toBe("deep");
		});
		it("returns deep for new files", () => {
			expect(determineDepth(20, 2, true)).toBe("deep");
		});
	});

	describe("getReflectionTemplate", () => {
		it("returns non-empty prompts for all combinations", () => {
			const types = ["bug_fix", "new_feature", "refactor", "unknown"] as const;
			const depths = ["light", "standard", "deep"] as const;
			for (const t of types) {
				for (const d of depths) {
					const tmpl = getReflectionTemplate(t, d);
					expect(tmpl.prompts.length).toBeGreaterThan(0);
				}
			}
		});
		it("deep templates include falsification", () => {
			const tmpl = getReflectionTemplate("bug_fix", "deep");
			expect(tmpl.falsification).toBeDefined();
			expect(tmpl.falsification!.length).toBeGreaterThan(0);
		});
		it("standard templates include proveIt", () => {
			const tmpl = getReflectionTemplate("new_feature", "standard");
			expect(tmpl.proveIt).toBeDefined();
		});
	});

	describe("buildReflectionDirective", () => {
		it("builds DIRECTIVE for deep", () => {
			const item = buildReflectionDirective("bug_fix", "deep");
			expect(item.level).toBe("DIRECTIVE");
			expect(item.message).toContain("Before moving on");
			expect(item.message).toContain("WRONG");
		});
		it("builds DIRECTIVE for standard", () => {
			const item = buildReflectionDirective("new_feature", "standard");
			expect(item.level).toBe("DIRECTIVE");
		});
		it("builds CONTEXT for light", () => {
			const item = buildReflectionDirective("refactor", "light");
			expect(item.level).toBe("CONTEXT");
		});
		it("includes knowledge hints when provided", () => {
			const item = buildReflectionDirective("bug_fix", "deep", ["await漏れ注意"]);
			expect(item.message).toContain("await漏れ注意");
		});
	});
});
