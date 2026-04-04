import { describe, expect, it } from "vitest";
import { sanitizeForStderr } from "../sanitize.ts";

describe("sanitizeForStderr", () => {
	it("passes through normal text", () => {
		expect(sanitizeForStderr("hello world")).toBe("hello world");
	});

	it("strips ANSI escape sequences", () => {
		expect(sanitizeForStderr("\x1B[31mred text\x1B[0m")).toBe("red text");
	});

	it("strips null bytes and control characters", () => {
		expect(sanitizeForStderr("file\x00name\x01.ts")).toBe("filename.ts");
	});

	it("preserves newlines and tabs", () => {
		expect(sanitizeForStderr("line1\nline2\ttab")).toBe("line1\nline2\ttab");
	});

	it("handles empty string", () => {
		expect(sanitizeForStderr("")).toBe("");
	});

	it("strips cursor movement sequences", () => {
		expect(sanitizeForStderr("\x1B[2Amove up")).toBe("move up");
	});
});
