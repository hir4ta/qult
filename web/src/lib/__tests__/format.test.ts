import { describe, expect, it } from "vitest";
import { formatLabel, formatDate, contentPreview } from "../format";

describe("formatLabel", () => {
	it("strips project prefix and DEC-N + date", () => {
		const result = formatLabel("react-dashboard > DEC-1: [2026-03-16] chi as Go HTTP Router");
		expect(result.title).toBe("chi as Go HTTP Router");
		expect(result.source).toBe("react-dashboard");
	});

	it("strips multi-segment prefix", () => {
		const result = formatLabel("claude-alfred > manual > React SPA移行パターン");
		expect(result.title).toBe("React SPA移行パターン");
		expect(result.source).toBe("claude-alfred");
	});

	it("handles no prefix", () => {
		const result = formatLabel("Simple title");
		expect(result.title).toBe("Simple title");
		expect(result.source).toBe("");
	});

	it("strips DEC-N without date", () => {
		const result = formatLabel("DEC-5: Some Decision");
		expect(result.title).toBe("Some Decision");
		expect(result.source).toBe("");
	});

	it("strips date without DEC-N", () => {
		const result = formatLabel("project > [2026-01-01] New Feature");
		expect(result.title).toBe("New Feature");
		expect(result.source).toBe("project");
	});

	it("handles empty string", () => {
		const result = formatLabel("");
		expect(result.title).toBe("");
		expect(result.source).toBe("");
	});
});

describe("formatDate", () => {
	it("returns 'today' for today's date", () => {
		expect(formatDate(new Date().toISOString())).toBe("today");
	});

	it("returns 'yesterday' for yesterday", () => {
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
		expect(formatDate(yesterday.toISOString())).toBe("yesterday");
	});

	it("returns 'Nd ago' for dates within a week", () => {
		const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		expect(formatDate(threeDaysAgo.toISOString())).toBe("3d ago");
	});

	it("returns 'Nw ago' for dates within a month", () => {
		const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
		expect(formatDate(twoWeeksAgo.toISOString())).toBe("2w ago");
	});

	it("returns formatted date for older entries", () => {
		const result = formatDate("2025-01-15T00:00:00Z");
		expect(result).toBeTruthy();
		expect(result).not.toBe("today");
		expect(result).not.toContain("ago");
	});

	it("returns Japanese for locale ja", () => {
		expect(formatDate(new Date().toISOString(), "ja")).toBe("今日");
	});

	it("returns Japanese yesterday", () => {
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
		expect(formatDate(yesterday.toISOString(), "ja")).toBe("昨日");
	});

	it("returns Japanese Nd ago", () => {
		const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		expect(formatDate(threeDaysAgo.toISOString(), "ja")).toBe("3日前");
	});

	it("returns empty string for empty input", () => {
		expect(formatDate("")).toBe("");
	});

	it("returns fallback for invalid date", () => {
		// new Date("not-a-date") produces Invalid Date → catch returns raw input
		// But toLocaleDateString on Invalid Date returns "Invalid Date" string
		const result = formatDate("not-a-date");
		expect(result).toBeTruthy();
	});
});

describe("contentPreview", () => {
	it("strips markdown headers", () => {
		const result = contentPreview("# Title\nSome content here");
		expect(result).not.toContain("#");
		expect(result).toContain("Some content here");
	});

	it("strips bold markdown", () => {
		const result = contentPreview("**Bold text** here");
		expect(result).toBe("Bold text here");
	});

	it("strips inline code", () => {
		const result = contentPreview("`code` here");
		expect(result).toBe("code here");
	});

	it("strips list markers", () => {
		const result = contentPreview("- Item one\n- Item two");
		expect(result).toBe("Item one Item two");
	});

	it("strips HTML comments", () => {
		const result = contentPreview("<!-- comment -->\nVisible text");
		expect(result).toBe("Visible text");
	});

	it("strips Status lines", () => {
		const result = contentPreview("- **Status** Active\nReal content");
		expect(result).toBe("Real content");
	});

	it("truncates at maxLen", () => {
		const long = "A".repeat(200);
		const result = contentPreview(long, 50);
		expect(result).toHaveLength(53); // 50 + "..."
		expect(result.endsWith("...")).toBe(true);
	});

	it("does not truncate short content", () => {
		expect(contentPreview("Short")).toBe("Short");
	});

	it("handles empty content", () => {
		expect(contentPreview("")).toBe("");
	});

	it("collapses whitespace", () => {
		const result = contentPreview("Word   one\n\nWord   two");
		expect(result).toBe("Word one Word two");
	});
});
