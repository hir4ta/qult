import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const MAX_CHECK_SIZE = 500_000;

/** Result of test quality analysis */
export interface TestQualityResult {
	/** Number of test cases found */
	testCount: number;
	/** Number of assertions found */
	assertionCount: number;
	/** Average assertions per test */
	avgAssertions: number;
	/** Detected test smells */
	smells: TestSmell[];
	/** Whether the file uses property-based testing */
	isPbt: boolean;
}

export interface TestSmell {
	type: string;
	line: number;
	message: string;
}

// ── Assertion patterns ───────────────────────────────────────

const ASSERTION_RE = /\b(expect|assert|should)\s*[.(]/g;
const TEST_CASE_RE = /\b(it|test)\s*\(/g;

// ── Weak matcher patterns ────────────────────────────────────
// These matchers accept anything truthy/defined — they don't verify specific values.

const WEAK_MATCHERS: { re: RegExp; name: string }[] = [
	{ re: /\.toBeTruthy\s*\(\s*\)/, name: "toBeTruthy()" },
	{ re: /\.toBeFalsy\s*\(\s*\)/, name: "toBeFalsy()" },
	{ re: /\.toBeDefined\s*\(\s*\)/, name: "toBeDefined()" },
	{ re: /\.toBeUndefined\s*\(\s*\)/, name: "toBeUndefined()" },
	{ re: /\.toBe\s*\(\s*true\s*\)/, name: "toBe(true)" },
	{ re: /\.toBe\s*\(\s*false\s*\)/, name: "toBe(false)" },
];

// ── Trivial assertion pattern ────────────────────────────────
// expect(x).toBe(x) or expect(x).toEqual(x) — same variable name
const TRIVIAL_ASSERTION_RE =
	/expect\s*\(\s*(\w+)\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/;

// ── Empty test pattern ───────────────────────────────────────
// it('...', () => {}) or test('...', () => {})
const EMPTY_TEST_RE =
	/\b(?:it|test)\s*\(\s*["'`][^"'`]*["'`]\s*,\s*(?:async\s+)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/;

// ── Mock/spy patterns ────────────────────────────────────────
const MOCK_RE =
	/\b(?:vi\.fn|jest\.fn|vi\.spyOn|jest\.spyOn|sinon\.stub|sinon\.spy|\.mockImplementation|\.mockReturnValue|\.mockResolvedValue|mock\()\s*\(/g;

// ── Always-true assertion ────────────────────────────────────
// expect(true).toBe(true), expect(1).toBeTruthy(), expect("str").toBeDefined()
const ALWAYS_TRUE_RE =
	/expect\s*\(\s*(?:true|1|"[^"]*"|'[^']*'|\d+)\s*\)\s*\.(?:toBe\s*\(\s*(?:true|1)\s*\)|toBeTruthy\s*\(\s*\)|toBeDefined\s*\(\s*\))/;

// ── Constant-to-constant assertion ──────────────────────────
// expect("hello").toBe("hello") or expect(42).toBe(42) — literal equals itself
const CONSTANT_SELF_RE =
	/expect\s*\(\s*(["'`][^"'`]*["'`]|\d+)\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/;

// ── Snapshot-only detection ─────────────────────────────────
const SNAPSHOT_RE = /\.toMatchSnapshot\s*\(|\.toMatchInlineSnapshot\s*\(/g;

// ── Implementation-coupled assertion ───��───────────────���─────
// Assertions that test internal method calls rather than behavior
const IMPL_COUPLED_RE =
	/expect\s*\(\s*\w+\s*\)\s*\.(?:toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes)\s*\(/;

// ── Async test without await ──────────────────────────────
const ASYNC_TEST_RE = /\b(?:it|test)\s*\(\s*["'`][^"'`]*["'`]\s*,\s*async\s/;
const AWAIT_RE = /\bawait\b/;

// ── Module-level mutable state ───────────────────────────
const MODULE_LET_RE = /^let\s+\w+\s*(?:[:=])/;

// ── Large test file threshold ────────────────────────────
const LARGE_TEST_FILE_LINES = 500;

// ── Large snapshot threshold (chars) ─────────────────────
const LARGE_SNAPSHOT_CHARS = 5000;

// ── PBT detection ──────────────────────────────────────────
const PBT_RE =
	/\b(?:fc\.assert|fc\.property|fast-check|@fast-check\/vitest|hypothesis\.given|@given)\b/;
const PBT_DEGENERATE_RUNS_RE = /numRuns\s*:\s*1\b/;
const PBT_CONSTRAINED_GEN_RE = /fc\.\w+\(\s*\{\s*min\s*:\s*(\d+)\s*,\s*max\s*:\s*\1\s*\}/;

// ── Setup/teardown block detection ─────────────────────────
const SETUP_BLOCK_RE = /\b(beforeEach|afterEach|beforeAll|afterAll)\s*\(/;

/** Count assertions, excluding those inside setup/teardown blocks.
 *  Uses simple brace-depth tracking — not perfect but avoids false positives. */
function countAssertionsOutsideSetup(code: string): number {
	const lines = code.split("\n");
	let inSetupBlock = false;
	let braceDepth = 0;
	let setupStartDepth = 0;
	let count = 0;

	for (const line of lines) {
		if (!inSetupBlock && SETUP_BLOCK_RE.test(line)) {
			inSetupBlock = true;
			setupStartDepth = braceDepth;
		}

		for (const ch of line) {
			if (ch === "{") braceDepth++;
			else if (ch === "}") {
				braceDepth--;
				if (inSetupBlock && braceDepth <= setupStartDepth) {
					inSetupBlock = false;
				}
			}
		}

		if (!inSetupBlock) {
			const matches = line.match(ASSERTION_RE);
			if (matches) count += matches.length;
		}
	}

	return count;
}

/** Analyze test quality for a given test file. Pure function (no side effects).
 *  Returns null if file cannot be analyzed. */
export function analyzeTestQuality(file: string): TestQualityResult | null {
	const cwd = resolve(process.cwd());
	const absPath = resolve(cwd, file);
	// Path traversal guard
	if (!absPath.startsWith(cwd)) return null;
	if (!existsSync(absPath)) return null;

	let content: string;
	try {
		content = readFileSync(absPath, "utf-8");
	} catch {
		return null;
	}
	if (content.length > MAX_CHECK_SIZE) return null;

	// Strip comments
	const codeOnly = content
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n");

	const lines = content.split("\n");
	const testCount = (codeOnly.match(TEST_CASE_RE) ?? []).length;
	// Skip quality check if no test cases found
	if (testCount === 0) return null;
	// Count assertions excluding those in setup/teardown blocks
	const assertionCount = countAssertionsOutsideSetup(codeOnly);
	const avgAssertions = assertionCount / testCount;

	const isPbt = PBT_RE.test(content);
	const smells: TestSmell[] = [];

	// PBT-specific smells
	if (isPbt) {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (PBT_DEGENERATE_RUNS_RE.test(line)) {
				smells.push({
					type: "pbt-degenerate-runs",
					line: i + 1,
					message: "numRuns: 1 defeats the purpose of property-based testing — increase run count",
				});
			}
			if (PBT_CONSTRAINED_GEN_RE.test(line)) {
				smells.push({
					type: "pbt-constrained-generator",
					line: i + 1,
					message: "Generator min equals max — produces a single constant value, not random input",
				});
			}
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trimStart();
		if (trimmed.startsWith("//")) continue;

		// Weak matchers
		for (const { re, name } of WEAK_MATCHERS) {
			if (re.test(line)) {
				smells.push({
					type: "weak-matcher",
					line: i + 1,
					message: `Weak matcher ${name} — consider asserting a specific value`,
				});
				break;
			}
		}

		// Trivial assertions (expect(x).toBe(x))
		if (TRIVIAL_ASSERTION_RE.test(line)) {
			smells.push({
				type: "trivial-assertion",
				line: i + 1,
				message: "Trivial assertion: comparing variable to itself",
			});
		}

		// Empty tests
		if (EMPTY_TEST_RE.test(line)) {
			smells.push({
				type: "empty-test",
				line: i + 1,
				message: "Empty test body — no assertions",
			});
		}

		// Always-true assertions
		if (ALWAYS_TRUE_RE.test(line)) {
			smells.push({
				type: "always-true",
				line: i + 1,
				message: "Always-true assertion — tests a literal, not computed behavior",
			});
		}

		// Constant-to-constant assertions (expect("x").toBe("x"))
		if (CONSTANT_SELF_RE.test(line)) {
			smells.push({
				type: "constant-self",
				line: i + 1,
				message: "Constant-to-constant assertion: literal compared to itself",
			});
		}

		// Implementation-coupled assertions
		if (IMPL_COUPLED_RE.test(line)) {
			smells.push({
				type: "impl-coupled",
				line: i + 1,
				message: "Tests mock calls instead of behavior — consider asserting outputs",
			});
		}
	}

	// Snapshot-only test: all assertions are snapshot matchers, no value assertions
	const snapshotCount = (codeOnly.match(SNAPSHOT_RE) ?? []).length;
	const nonSnapshotAssertions = assertionCount - snapshotCount;
	if (snapshotCount > 0 && nonSnapshotAssertions <= 0) {
		smells.push({
			type: "snapshot-only",
			line: 0,
			message: `All ${snapshotCount} assertion(s) are snapshots — add value-based assertions to verify behavior`,
		});
	}

	// Mock overuse: more mocks than assertions
	const mockCount = (codeOnly.match(MOCK_RE) ?? []).length;
	if (mockCount > 0 && mockCount > assertionCount) {
		smells.push({
			type: "mock-overuse",
			line: 0,
			message: `Mock overuse: ${mockCount} mocks vs ${assertionCount} assertions — tests may verify mocks, not behavior`,
		});
	}

	// Async test without await: promise may silently pass without being awaited
	// Uses string-aware brace counting to avoid false positives from braces in strings/templates
	let inAsyncTest = false;
	let asyncTestLine = 0;
	let asyncTestHasAwait = false;
	let asyncBraceDepth = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!inAsyncTest && ASYNC_TEST_RE.test(line)) {
			inAsyncTest = true;
			asyncTestLine = i + 1;
			asyncTestHasAwait = false;
			asyncBraceDepth = 0;
		}
		if (inAsyncTest) {
			if (AWAIT_RE.test(line)) asyncTestHasAwait = true;
			// Count braces outside strings/templates/regex
			let inStr: string | null = null;
			let escaped = false;
			for (const ch of line) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					continue;
				}
				if (inStr) {
					if (ch === inStr) inStr = null;
					continue;
				}
				if (ch === '"' || ch === "'" || ch === "`") {
					inStr = ch;
					continue;
				}
				if (ch === "{") asyncBraceDepth++;
				else if (ch === "}") {
					asyncBraceDepth--;
					if (asyncBraceDepth <= 0) {
						if (!asyncTestHasAwait) {
							smells.push({
								type: "async-no-await",
								line: asyncTestLine,
								message: "Async test without await — promises may resolve after test completes",
							});
						}
						inAsyncTest = false;
					}
				}
			}
		}
	}

	// Module-level mutable state: `let` at top level suggests shared test state
	let moduleLetCount = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (MODULE_LET_RE.test(line)) {
			moduleLetCount++;
			if (moduleLetCount === 1) {
				smells.push({
					type: "shared-mutable-state",
					line: i + 1,
					message:
						"Module-level `let` in test file — shared mutable state may cause test isolation issues",
				});
			}
		}
	}

	// Large test file: suggests mixing concerns
	if (lines.length > LARGE_TEST_FILE_LINES) {
		smells.push({
			type: "large-test-file",
			line: 0,
			message: `Test file has ${lines.length} lines (>${LARGE_TEST_FILE_LINES}) — consider splitting by concern`,
		});
	}

	// Snapshot file bloat: check corresponding .snap file
	try {
		const snapDir = `${dirname(absPath)}/__snapshots__/`;
		const snapFile = `${snapDir}${basename(absPath)}.snap`;
		if (existsSync(snapFile)) {
			const snapContent = readFileSync(snapFile, "utf-8");
			if (snapContent.length > LARGE_SNAPSHOT_CHARS) {
				smells.push({
					type: "snapshot-bloat",
					line: 0,
					message: `Snapshot file is ${Math.round(snapContent.length / 1024)}KB — large snapshots capture implementation details`,
				});
			}
		}
	} catch {
		/* fail-open */
	}

	// ── New smell: no-error-path ─────────────────────────────
	// If test has no toThrow/rejects/catch/error assertions but implementation has throw/reject
	if (testCount >= 2) {
		const hasErrorAssertions =
			/(?:toThrow|rejects\.toThrow|\.rejects\.|\.catch\s*\(|expect\(.*error)/i.test(codeOnly);
		if (!hasErrorAssertions) {
			try {
				const implFile = findImplFile(absPath);
				if (implFile) {
					const implContent = readFileSync(implFile, "utf-8");
					if (/\bthrow\b|\breject\b|Promise\.reject/m.test(implContent)) {
						smells.push({
							type: "no-error-path",
							line: 0,
							message:
								"Implementation has throw/reject but test has no error-path assertions (toThrow, rejects, catch)",
						});
					}
				}
			} catch {
				/* fail-open */
			}
		}
	}

	// ── New smell: happy-path-only ───────────────────────────
	// If all test descriptions are positive (no "invalid", "error", "fail", etc.)
	if (testCount >= 3) {
		const descRe = /\b(?:it|test)\s*\(\s*["'`]([^"'`]*)["'`]/g;
		const negativeRe =
			/\b(?:invalid|error|fail|reject|throw|empty|null|missing|not\b|negative|undefined|wrong|bad|broken|illegal)/i;
		let allPositive = true;
		for (const match of codeOnly.matchAll(descRe)) {
			if (negativeRe.test(match[1]!)) {
				allPositive = false;
				break;
			}
		}
		if (allPositive) {
			smells.push({
				type: "happy-path-only",
				line: 0,
				message:
					"All test descriptions are positive — consider testing error/edge cases (invalid input, null, empty)",
			});
		}
	}

	// ── New smell: missing-boundary ──────────────────────────
	// If assertion chains never use boundary values (0, -1, null, undefined, NaN, "", [], Infinity)
	// Checks both expect() args AND matcher args (e.g., .toBe(0), .toEqual(null))
	if (testCount >= 3) {
		const boundaryValueRe =
			/(?:\b0\b|\b-1\b|\bnull\b|\bundefined\b|\bNaN\b|\bInfinity\b|["'`]{2}|\[\s*\])/;
		const hasExpectLine = /expect\s*\(/.test(codeOnly);
		const hasBoundary =
			hasExpectLine &&
			codeOnly.split("\n").some((line) => /expect\s*\(/.test(line) && boundaryValueRe.test(line));
		if (!hasBoundary) {
			smells.push({
				type: "missing-boundary",
				line: 0,
				message:
					"No boundary values tested (0, -1, null, undefined, NaN, empty string/array) — consider edge cases",
			});
		}
	}

	// ── New smell: concentrated-pattern ──────────────────────
	// If 80%+ of assertions use the same matcher name (e.g., all use .toBe)
	if (testCount >= 5 && assertionCount >= 5) {
		const matcherNameRe = /\.(toBe|toEqual|toStrictEqual|toThrow|toMatch|toContain)\s*\(/g;
		const matcherCounts = new Map<string, number>();
		let totalMatched = 0;
		for (const m of codeOnly.matchAll(matcherNameRe)) {
			const key = m[1]!;
			matcherCounts.set(key, (matcherCounts.get(key) ?? 0) + 1);
			totalMatched++;
		}
		if (totalMatched > 0) {
			for (const [matcher, count] of matcherCounts) {
				const ratio = Math.min(count / totalMatched, 1.0);
				if (ratio >= 0.8) {
					smells.push({
						type: "concentrated-pattern",
						line: 0,
						message: `${Math.round(ratio * 100)}% of assertions use .${matcher}() — tests may miss diverse behaviors`,
					});
					break;
				}
			}
		}
	}

	return { testCount, assertionCount, avgAssertions, smells, isPbt };
}

/** Find implementation file for a test file. Simple heuristic using naming conventions. */
function findImplFile(testPath: string): string | null {
	try {
		const dir = dirname(testPath);
		const base = basename(testPath);
		// Common patterns: foo.test.ts -> foo.ts, foo.spec.ts -> foo.ts
		const implName = base.replace(/\.(?:test|spec)(\.[^.]+)$/, "$1");
		// Check in same dir
		const sameDirPath = resolve(dir, implName);
		if (existsSync(sameDirPath)) return sameDirPath;
		// Check in parent dir (src/__tests__/foo.test.ts -> src/foo.ts)
		const parentDir = dirname(dir);
		const parentPath = resolve(parentDir, implName);
		if (existsSync(parentPath)) return parentPath;
		// Check in src/ dir (tests/foo.test.ts -> src/foo.ts)
		const srcPath = resolve(parentDir, "src", implName);
		if (existsSync(srcPath)) return srcPath;
		return null;
	} catch {
		return null;
	}
}

/** Format test quality result as warning lines for stderr output. */
export function formatTestQualityWarnings(
	file: string,
	result: TestQualityResult,
	taskKey?: string,
): string[] {
	const warnings: string[] = [];
	const prefix = taskKey ? `${taskKey}: ` : "";

	if (result.avgAssertions < 2 && !result.isPbt) {
		warnings.push(
			`${prefix}${file} has ~${result.avgAssertions.toFixed(1)} assertions/test (minimum 2)`,
		);
	}

	// Group smells by type for concise output
	const smellsByType = new Map<string, TestSmell[]>();
	for (const smell of result.smells) {
		const existing = smellsByType.get(smell.type) ?? [];
		existing.push(smell);
		smellsByType.set(smell.type, existing);
	}

	for (const [type, items] of smellsByType) {
		if (items.length === 1) {
			warnings.push(`${prefix}${file}:${items[0]!.line}: ${items[0]!.message}`);
		} else {
			const lineNums = items
				.slice(0, 5)
				.map((s) => s.line)
				.filter((l) => l > 0)
				.join(",");
			const suffix = items.length > 5 ? ` (+${items.length - 5} more)` : "";
			warnings.push(
				`${prefix}${file}: ${items.length}x ${type} (L${lineNums}${suffix}) — ${items[0]!.message}`,
			);
		}
	}

	// PBT recommendation when edge-case coverage is weak
	if (!result.isPbt) {
		const hasPbtSmell = result.smells.some(
			(s) => s.type === "happy-path-only" || s.type === "missing-boundary",
		);
		if (hasPbtSmell) {
			const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
			const JS_TS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
			const PY = new Set([".py", ".pyi"]);
			if (JS_TS.has(ext)) {
				warnings.push(
					`${prefix}${file}: Consider property-based testing with fast-check: fc.assert(fc.property(fc.integer(), (n) => ...)) to auto-discover edge cases`,
				);
			} else if (PY.has(ext)) {
				warnings.push(
					`${prefix}${file}: Consider property-based testing with hypothesis: @given(st.integers()) to auto-discover edge cases`,
				);
			} else {
				warnings.push(
					`${prefix}${file}: Consider property-based testing to auto-discover edge cases and boundary values`,
				);
			}
		}
	}

	return warnings;
}
