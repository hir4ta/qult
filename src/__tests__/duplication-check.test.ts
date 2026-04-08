import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, ensureSession, setProjectPath, setSessionScope, useTestDb } from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";
import { disableGate, flush as flushSessionState } from "../state/session-state.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-duplication-check-test");
const originalCwd = process.cwd();

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	closeDb();
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("detectDuplication", () => {
	async function detect(file: string) {
		const { detectDuplication } = await import("../hooks/detectors/duplication-check.ts");
		return detectDuplication(file);
	}

	it("detects intra-file 4-line duplicate", async () => {
		const file = join(TEST_DIR, "dup.ts");
		writeFileSync(
			file,
			[
				"function foo() {",
				"  const x = 1;",
				"  const y = x + 2;",
				"  return y * 3;",
				"}",
				"",
				"function bar() {",
				"  const x = 1;",
				"  const y = x + 2;",
				"  return y * 3;",
				"}",
			].join("\n"),
		);
		const fixes = await detect(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.gate).toBe("duplication-check");
		expect(fixes[0]!.errors[0]).toContain("duplicate");
	});

	it("ignores 3-line repeats (below threshold)", async () => {
		const file = join(TEST_DIR, "short.ts");
		writeFileSync(
			file,
			[
				"function foo() {",
				"  const x = 1;",
				"  return x;",
				"}",
				"",
				"function bar() {",
				"  const x = 1;",
				"  return x;",
				"}",
			].join("\n"),
		);
		const fixes = await detect(file);
		expect(fixes).toEqual([]);
	});

	it("returns empty when gate disabled", async () => {
		disableGate("duplication-check");
		flushSessionState();
		resetAllCaches();

		const file = join(TEST_DIR, "dup2.ts");
		writeFileSync(
			file,
			[
				"function foo() {",
				"  const x = 1;",
				"  const y = x + 2;",
				"  return y * 3;",
				"}",
				"function bar() {",
				"  const x = 1;",
				"  const y = x + 2;",
				"  return y * 3;",
				"}",
			].join("\n"),
		);
		const fixes = await detect(file);
		expect(fixes).toEqual([]);
	});

	it("returns empty for non-code files", async () => {
		const file = join(TEST_DIR, "data.json");
		writeFileSync(file, '{"key": "value"}');
		const fixes = await detect(file);
		expect(fixes).toEqual([]);
	});
});

describe("detectCrossFileDuplication", () => {
	async function detectCross(file: string, sessionFiles: string[]) {
		const { detectCrossFileDuplication } = await import("../hooks/detectors/duplication-check.ts");
		return detectCrossFileDuplication(file, sessionFiles);
	}

	it("detects cross-file duplicate blocks", async () => {
		const block = [
			"  const config = loadConfig();",
			"  const threshold = config.review.score_threshold;",
			"  if (threshold > 0) {",
			"    return threshold;",
		].join("\n");

		const fileA = join(TEST_DIR, "a.ts");
		const fileB = join(TEST_DIR, "b.ts");
		writeFileSync(fileA, `function foo() {\n${block}\n  }\n}`);
		writeFileSync(fileB, `function bar() {\n${block}\n  }\n}`);

		const warnings = await detectCross(fileA, [fileB]);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("b.ts");
	});

	it("reports all matching blocks, not just first", async () => {
		const block1 = "const x = 1;\nconst y = 2;\nconst z = 3;\nreturn x + y;";
		const block2 = "const a = 10;\nconst b = 20;\nconst c = 30;\nreturn a + b;";

		const fileA = join(TEST_DIR, "multi-a.ts");
		const fileB = join(TEST_DIR, "multi-b.ts");
		writeFileSync(fileA, `${block1}\n\n${block2}`);
		writeFileSync(fileB, `${block1}\n\n${block2}`);

		const warnings = await detectCross(fileA, [fileB]);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("matching");
		expect(warnings[0]).toContain("blocks");
		expect(warnings[0]).not.toContain("1 matching block");
	});

	it("returns empty when no cross-file duplicates", async () => {
		const fileA = join(TEST_DIR, "c.ts");
		const fileB = join(TEST_DIR, "d.ts");
		writeFileSync(fileA, "function foo() { return 1; }");
		writeFileSync(fileB, "function bar() { return 2; }");

		const warnings = await detectCross(fileA, [fileB]);
		expect(warnings).toEqual([]);
	});

	it("skips check when session has >20 files and logs warning", async () => {
		const fileA = join(TEST_DIR, "many-a.ts");
		writeFileSync(fileA, "function foo() {\nconst x = 1;\nconst y = 2;\nconst z = 3;\n}");

		const sessionFiles = [fileA];
		for (let i = 0; i < 21; i++) {
			sessionFiles.push(join(TEST_DIR, `dummy-${i}.ts`));
		}

		const stderrSpy = vi.spyOn(process.stderr, "write");
		const warnings = await detectCross(fileA, sessionFiles);

		expect(warnings).toEqual([]);
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining("Cross-file duplication check skipped"),
		);
		stderrSpy.mockRestore();
	});
});
