import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStateJSON, writeStateJSON } from "../state.js";

/**
 * Test pace management logic directly via state files.
 * We can't import from post-tool.ts in vitest (bun:sqlite dep),
 * so we replicate the threshold logic here for validation.
 */

function checkRedThreshold(cwd: string): boolean {
	try {
		const pace = readStateJSON<{
			started_at: string;
			last_commit_at: string;
			files_changed_since_commit: string[];
			lines_changed_since_commit: number;
		} | null>(cwd, "session-pace.json", null);
		if (!pace?.started_at) return false;

		const ref = pace.last_commit_at || pace.started_at;
		const mins = (Date.now() - new Date(ref).getTime()) / 60000;
		const files = pace.files_changed_since_commit.length;
		const lines = pace.lines_changed_since_commit;
		return mins >= 35 && (files >= 10 || lines >= 500);
	} catch {
		return false;
	}
}

describe("pace management", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pace-test-"));
		mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
	});

	afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

	it("red threshold is false when no pace data", () => {
		expect(checkRedThreshold(tmpDir)).toBe(false);
	});

	it("red threshold is false when recently committed", () => {
		writeStateJSON(tmpDir, "session-pace.json", {
			started_at: new Date(Date.now() - 60 * 60000).toISOString(),
			last_commit_at: new Date(Date.now() - 5 * 60000).toISOString(),
			tool_calls_since_commit: 3,
			files_changed_since_commit: ["a.ts", "b.ts"],
			lines_changed_since_commit: 50,
		});
		expect(checkRedThreshold(tmpDir)).toBe(false);
	});

	it("red threshold is false when time exceeded but files/lines low", () => {
		writeStateJSON(tmpDir, "session-pace.json", {
			started_at: new Date(Date.now() - 40 * 60000).toISOString(),
			last_commit_at: "",
			tool_calls_since_commit: 10,
			files_changed_since_commit: ["a.ts", "b.ts"],
			lines_changed_since_commit: 50,
		});
		expect(checkRedThreshold(tmpDir)).toBe(false);
	});

	it("red threshold is true when 35min AND 10+ files", () => {
		writeStateJSON(tmpDir, "session-pace.json", {
			started_at: new Date(Date.now() - 40 * 60000).toISOString(),
			last_commit_at: "",
			tool_calls_since_commit: 50,
			files_changed_since_commit: Array.from({ length: 12 }, (_, i) => `file${i}.ts`),
			lines_changed_since_commit: 300,
		});
		expect(checkRedThreshold(tmpDir)).toBe(true);
	});

	it("red threshold is true when 35min AND 500+ lines", () => {
		writeStateJSON(tmpDir, "session-pace.json", {
			started_at: new Date(Date.now() - 36 * 60000).toISOString(),
			last_commit_at: "",
			tool_calls_since_commit: 20,
			files_changed_since_commit: ["a.ts"],
			lines_changed_since_commit: 600,
		});
		expect(checkRedThreshold(tmpDir)).toBe(true);
	});

	it("uses last_commit_at as reference when available", () => {
		writeStateJSON(tmpDir, "session-pace.json", {
			started_at: new Date(Date.now() - 120 * 60000).toISOString(),
			last_commit_at: new Date(Date.now() - 10 * 60000).toISOString(),
			tool_calls_since_commit: 5,
			files_changed_since_commit: Array.from({ length: 15 }, (_, i) => `file${i}.ts`),
			lines_changed_since_commit: 600,
		});
		expect(checkRedThreshold(tmpDir)).toBe(false);
	});

	it("pace state round-trips correctly", () => {
		const pace = {
			started_at: new Date().toISOString(),
			last_commit_at: "",
			tool_calls_since_commit: 5,
			files_changed_since_commit: ["a.ts", "b.ts"],
			lines_changed_since_commit: 100,
		};
		writeStateJSON(tmpDir, "session-pace.json", pace);
		const read = readStateJSON(tmpDir, "session-pace.json", null);
		expect(read).toEqual(pace);
	});
});
