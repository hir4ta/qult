import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStateJSON, writeStateJSON } from "../state.js";

interface FixContext {
	filePath: string;
	errorSignature: string;
	errorType: string;
	rule: string;
	beforeSnapshot: string;
	timestamp: string;
}

const FIX_CONTEXT_FILE = "fix-context.json";

describe("fix-context state management", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "alfred-fix-test-"));
		mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("saves fix context on gate failure", () => {
		const ctx: FixContext = {
			filePath: "/src/foo.ts",
			errorSignature: "prefer-const",
			errorType: "lint",
			rule: "prefer-const",
			beforeSnapshot: "let x = 1;",
			timestamp: new Date().toISOString(),
		};
		writeStateJSON(tmpDir, FIX_CONTEXT_FILE, ctx);

		const read = readStateJSON<FixContext | null>(tmpDir, FIX_CONTEXT_FILE, null);
		expect(read).not.toBeNull();
		expect(read!.filePath).toBe("/src/foo.ts");
		expect(read!.beforeSnapshot).toBe("let x = 1;");
	});

	it("returns null when no fix context exists", () => {
		const read = readStateJSON<FixContext | null>(tmpDir, FIX_CONTEXT_FILE, null);
		expect(read).toBeNull();
	});

	it("detects same-file fix within timeout", () => {
		const ctx: FixContext = {
			filePath: "/src/foo.ts",
			errorSignature: "prefer-const",
			errorType: "lint",
			rule: "prefer-const",
			beforeSnapshot: "let x = 1;",
			timestamp: new Date().toISOString(),
		};
		writeStateJSON(tmpDir, FIX_CONTEXT_FILE, ctx);

		const read = readStateJSON<FixContext | null>(tmpDir, FIX_CONTEXT_FILE, null);
		expect(read).not.toBeNull();

		// Same file, within 10 minutes
		const age = Date.now() - new Date(read!.timestamp).getTime();
		const isMatch = read!.filePath === "/src/foo.ts" && age < 10 * 60 * 1000;
		expect(isMatch).toBe(true);
	});

	it("rejects different file", () => {
		const ctx: FixContext = {
			filePath: "/src/foo.ts",
			errorSignature: "prefer-const",
			errorType: "lint",
			rule: "prefer-const",
			beforeSnapshot: "let x = 1;",
			timestamp: new Date().toISOString(),
		};
		writeStateJSON(tmpDir, FIX_CONTEXT_FILE, ctx);

		const read = readStateJSON<FixContext | null>(tmpDir, FIX_CONTEXT_FILE, null);
		const isMatch = read!.filePath === "/src/bar.ts";
		expect(isMatch).toBe(false);
	});

	it("rejects expired fix context (>10 min)", () => {
		const ctx: FixContext = {
			filePath: "/src/foo.ts",
			errorSignature: "prefer-const",
			errorType: "lint",
			rule: "prefer-const",
			beforeSnapshot: "let x = 1;",
			timestamp: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
		};
		writeStateJSON(tmpDir, FIX_CONTEXT_FILE, ctx);

		const read = readStateJSON<FixContext | null>(tmpDir, FIX_CONTEXT_FILE, null);
		const age = Date.now() - new Date(read!.timestamp).getTime();
		const isMatch = read!.filePath === "/src/foo.ts" && age < 10 * 60 * 1000;
		expect(isMatch).toBe(false);
	});
});
