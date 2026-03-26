import { describe, expect, it } from "vitest";
import {
	type ConventionRule,
	type ConventionViolation,
	checkConventions,
} from "../convention-check.js";

describe("checkConventions", () => {
	const anyRule: ConventionRule = {
		pattern: "Avoid any type",
		category: "style",
		check: { type: "regex", match: ":\\s*any\\b|as\\s+any\\b", filePattern: "*.ts" },
	};

	it("detects any type violation", () => {
		const violations = checkConventions("src/foo.ts", "const x: any = 42;\nconst y = z as any;", [
			anyRule,
		]);
		expect(violations).toHaveLength(2);
		expect(violations[0]!.rule).toBe("Avoid any type");
		expect(violations[0]!.line).toBe(1);
		expect(violations[1]!.line).toBe(2);
	});

	it("passes clean code", () => {
		const violations = checkConventions(
			"src/foo.ts",
			"const x: number = 42;\nconst y: string = 'hello';",
			[anyRule],
		);
		expect(violations).toHaveLength(0);
	});

	it("respects filePattern", () => {
		const violations = checkConventions("src/foo.py", "x: any = 42", [anyRule]);
		expect(violations).toHaveLength(0);
	});

	it("skips rules without check field", () => {
		const softRule: ConventionRule = {
			pattern: "Prefer early return",
			category: "style",
		};
		const violations = checkConventions("src/foo.ts", "if (x) { if (y) { } }", [softRule]);
		expect(violations).toHaveLength(0);
	});

	it("caps violations at 10", () => {
		const content = Array(20).fill("const x: any = 1;").join("\n");
		const violations = checkConventions("src/foo.ts", content, [anyRule]);
		expect(violations.length).toBeLessThanOrEqual(10);
	});

	it("handles multiple rules", () => {
		const noConsoleRule: ConventionRule = {
			pattern: "No console.log in production code",
			category: "style",
			check: { type: "regex", match: "console\\.log\\(", filePattern: "*.ts" },
		};
		const violations = checkConventions("src/foo.ts", "const x: any = 1;\nconsole.log(x);", [
			anyRule,
			noConsoleRule,
		]);
		expect(violations).toHaveLength(2);
		expect(violations[0]!.rule).toBe("Avoid any type");
		expect(violations[1]!.rule).toBe("No console.log in production code");
	});
});
