import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-health-score-test");
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("computeFileHealthScore", () => {
	async function score(file: string) {
		const { computeFileHealthScore } = await import("../hooks/detectors/health-score.ts");
		return computeFileHealthScore(file);
	}

	it("returns 10 for clean file", async () => {
		const file = join(TEST_DIR, "clean.ts");
		writeFileSync(file, "export const x = 1;\n");
		const result = await score(file);
		expect(result.score).toBe(10);
		expect(result.breakdown).toEqual({});
	});

	it("reduces score for security issues", async () => {
		const file = join(TEST_DIR, "insecure.ts");
		writeFileSync(file, `const key = "AKIAIOSFODNN7EXAMPLE1";\nexport default key;\n`);
		const result = await score(file);
		expect(result.score).toBeLessThan(10);
		expect(result.breakdown.security).toBeLessThan(0);
	});

	it("clamps score to 0 minimum", async () => {
		const file = join(TEST_DIR, "terrible.ts");
		// Multiple security issues to push score below 0
		writeFileSync(
			file,
			[
				`const a = "AKIAIOSFODNN7EXAMPLE1";`,
				`const b = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";`,
				`const c = "sk_test_12345678901234567890";`,
				`const d = "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q";`,
				`const e = "npm_1234567890abcdefghijklmnopqrstuv";`,
				`const f = "SG.abcdefghijklmnop.qrstuvwxyz123456";`,
				`export default { a, b, c, d, e, f };`,
			].join("\n"),
		);
		const result = await score(file);
		expect(result.score).toBe(0);
	});

	it("returns 10 for nonexistent file (fail-open)", async () => {
		const result = await score("/nonexistent/path/foo.ts");
		expect(result.score).toBe(10);
	});
});
