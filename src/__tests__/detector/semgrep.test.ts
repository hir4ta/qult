/**
 * Tests for the semgrep wrapper. We can't assume semgrep is installed in CI,
 * so the assertions focus on the skip-path semantics that work everywhere.
 */

import { describe, expect, it } from "vitest";
import { isSemgrepAvailable, runSemgrepScan } from "../../detector/semgrep.ts";

describe("runSemgrepScan", () => {
	it("returns skipped when files=[]", () => {
		const result = runSemgrepScan([]);
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toContain("no files");
	});

	it.skipIf(isSemgrepAvailable())("returns skipped when semgrep is not installed", () => {
		const result = runSemgrepScan(["/dev/null"]);
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toContain("semgrep");
	});

	it("isSemgrepAvailable returns a boolean", () => {
		expect(typeof isSemgrepAvailable()).toBe("boolean");
	});
});
