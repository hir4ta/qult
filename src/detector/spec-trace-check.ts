import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";

/**
 * Parse a plan Verify field in the format "testFile:testFunction".
 * Returns null if the format is invalid.
 */
export function parseVerifyField(
	verify: string,
): { testFile: string; testFunction: string } | null {
	if (!verify?.includes(":")) return null;
	const lastColon = verify.lastIndexOf(":");
	const testFile = verify.slice(0, lastColon).trim();
	const testFunction = verify.slice(lastColon + 1).trim();
	if (!testFile || !testFunction) return null;
	return { testFile, testFunction };
}

/**
 * Validate that a test file exists on disk.
 */
export function validateTestFileExists(testFilePath: string): boolean {
	return existsSync(testFilePath);
}

/**
 * Validate that a test file imports and covers the implementation file.
 * Uses heuristic: test file must contain an import statement that references
 * the implementation file (by relative path or basename).
 */
export function validateTestCoversImpl(
	testFile: string,
	_testFunction: string,
	implFile: string,
	_projectRoot: string,
): boolean {
	if (!existsSync(testFile)) return false;

	try {
		const content = readFileSync(testFile, "utf-8");
		const implBasename = basename(implFile).replace(/\.[^.]+$/, ""); // "utils" from "utils.ts"
		const implRelative = relative(dirname(testFile), implFile)
			.replace(/\\/g, "/") // normalize Windows paths
			.replace(/\.[^.]+$/, ""); // strip extension

		// Check if test file imports from the implementation file
		// Match patterns like: from "../utils", from "./utils", from "../utils.ts"
		const importPatterns = [
			// ESM/CJS import from relative path (with or without extension)
			new RegExp(`(?:import|require).*['"].*${escapeRegex(implRelative)}(?:\\.[^'"]*)?['"]`, "m"),
			// Basename match for simpler cases
			new RegExp(`(?:import|require).*['"].*/${escapeRegex(implBasename)}(?:\\.[^'"]*)?['"]`, "m"),
		];

		return importPatterns.some((pattern) => pattern.test(content));
	} catch {
		return false; // fail-open
	}
}

/**
 * Validate that a specific test function/describe block exists in the test file.
 * Searches for it('name'), test('name'), describe('name'), or def test_name() patterns.
 */
export function validateTestFunctionExists(testFile: string, functionName: string): boolean {
	if (!existsSync(testFile)) return false;
	try {
		const content = readFileSync(testFile, "utf-8");
		const ext = testFile.split(".").pop()?.toLowerCase() ?? "";

		if (ext === "py") {
			// Python: def test_xxx() or def xxx()
			const pyRe = /\bdef\s+(\w+)\s*\(/g;
			for (const m of content.matchAll(pyRe)) {
				if (m[1] === functionName) return true;
			}
			return false;
		}

		// TS/JS: it('...'), test('...'), describe('...')
		const jsRe = /\b(?:it|test|describe)\s*\(\s*["'`]([^"'`]*)["'`]/g;
		for (const m of content.matchAll(jsRe)) {
			if (m[1] === functionName || m[1]?.includes(functionName)) return true;
		}
		return false;
	} catch {
		return false;
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
