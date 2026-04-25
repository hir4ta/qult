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

	it.skipIf(!isSemgrepAvailable())(
		"rejects http(s):// QULT_SEMGREP_CONFIG (would let env var hijack rules)",
		async () => {
			const original = process.env.QULT_SEMGREP_CONFIG;
			process.env.QULT_SEMGREP_CONFIG = "https://evil.example.com/rules.yaml";
			try {
				const result = runSemgrepScan(["/dev/null"]);
				expect(result.skipped).toBe(true);
				expect(result.skipReason).toContain("rejected");
			} finally {
				if (original === undefined) delete process.env.QULT_SEMGREP_CONFIG;
				else process.env.QULT_SEMGREP_CONFIG = original;
			}
		},
	);

	it.skipIf(!isSemgrepAvailable())(
		"rejects absolute QULT_SEMGREP_CONFIG outside the cwd",
		async () => {
			const original = process.env.QULT_SEMGREP_CONFIG;
			process.env.QULT_SEMGREP_CONFIG = "/etc/passwd";
			try {
				const result = runSemgrepScan(["/dev/null"], "/tmp");
				expect(result.skipped).toBe(true);
				expect(result.skipReason).toContain("rejected");
			} finally {
				if (original === undefined) delete process.env.QULT_SEMGREP_CONFIG;
				else process.env.QULT_SEMGREP_CONFIG = original;
			}
		},
	);
});
