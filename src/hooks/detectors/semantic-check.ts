import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { isGateDisabled } from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";
import { sanitizeForStderr } from "../sanitize.ts";

const JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const PY_EXTS = new Set([".py", ".pyi"]);
const CHECKABLE_EXTS = new Set([...JS_TS_EXTS, ...PY_EXTS, ".go", ".rs", ".rb", ".java", ".kt"]);

const MAX_CHECK_SIZE = 500_000;

// ── Suppression comments ──────────────────────────────────────
// Lines near these comments are intentional, not bugs.
const INTENTIONAL_RE = /(?:\/\/|\/\*|#)\s*(?:fail-open|intentional|deliberate|nolint|noqa|NOLINT)/i;

// ── Empty catch block detection ───────────────────────────────

/** Match `catch { }` or `catch (e) { }` with only whitespace inside.
 *  Multiline: we scan for `catch` then check if the block body is empty. */
function detectEmptyCatch(lines: string[]): string[] {
	const errors: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trimStart();

		// Skip comment lines
		if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;

		// Match catch with opening brace on same line
		if (!/\bcatch\b/.test(trimmed)) continue;
		if (!trimmed.includes("{")) continue;

		// Check suppression on catch line or line before
		if (INTENTIONAL_RE.test(line)) continue;
		if (i > 0 && INTENTIONAL_RE.test(lines[i - 1]!)) continue;

		// Find the closing brace — look at same line first, then next few lines
		const afterBrace = trimmed.slice(trimmed.indexOf("{") + 1);

		// Same-line empty catch: `catch (e) { }`
		if (/^\s*\}/.test(afterBrace)) {
			errors.push(`L${i + 1}: Empty catch block — errors silently swallowed`);
			continue;
		}

		// Multi-line: check next 2 lines for `}` with only whitespace between
		if (afterBrace.trim() === "") {
			const next = lines[i + 1]?.trimStart() ?? "";
			// Check suppression on line inside catch
			if (INTENTIONAL_RE.test(lines[i + 1] ?? "")) continue;
			if (/^\}/.test(next)) {
				errors.push(`L${i + 1}: Empty catch block — errors silently swallowed`);
			}
		}
	}
	return errors;
}

// ── Ignored return value detection ────────────────────────────

// Methods whose return value should never be discarded
const PURE_METHODS_RE =
	/^\s*(?:[a-zA-Z_$][\w$.]*\s*\.\s*)?(?:map|filter|reduce|flatMap|flat|slice|concat|toSorted|toReversed|toSpliced|replace|replaceAll|trim|trimStart|trimEnd|padStart|padEnd|substring|toLowerCase|toUpperCase)\s*\(/;

// Chained calls are OK: `arr.map(...).forEach(...)` — detect by checking if line continues with `.`
const CHAIN_CONTINUATION_RE = /\)\s*\./;

function detectIgnoredReturn(lines: string[]): string[] {
	const errors: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trimStart();

		// Skip comment lines
		if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;

		// Must match a pure method at statement start (no `=`, `return`, `const`, `let`, `var`, `yield`, `await` before it)
		if (!PURE_METHODS_RE.test(trimmed)) continue;

		// Not a bare statement if preceded by assignment or return keywords
		if (/(?:^|[\s(,=])\b(?:return|const|let|var|yield|await)\s/.test(trimmed)) continue;
		if (/=\s*(?:[a-zA-Z_$][\w$.]*\s*\.\s*)?(?:map|filter|reduce)/.test(trimmed)) continue;

		// Not an issue if it's part of a chain
		if (CHAIN_CONTINUATION_RE.test(line)) continue;
		// Check if next line is a continuation (chained)
		const nextLine = lines[i + 1]?.trimStart() ?? "";
		if (nextLine.startsWith(".")) continue;

		if (INTENTIONAL_RE.test(line)) continue;

		errors.push(
			`L${i + 1}: Return value of pure method discarded — probable no-op (assign or remove)`,
		);
	}
	return errors;
}

// ── Assignment in condition detection ─────────────────────────

const CONDITION_ASSIGNMENT_RE = /\b(?:if|while)\s*\(.*[^!=<>]=(?!=)[^=]/;
// Exclude destructuring: `if (const { a } = ...)`
const DESTRUCTURE_RE = /\b(?:const|let|var)\s/;

function detectConditionAssignment(lines: string[]): string[] {
	const errors: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trimStart();

		if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
		if (!CONDITION_ASSIGNMENT_RE.test(trimmed)) continue;
		if (DESTRUCTURE_RE.test(trimmed)) continue;
		if (INTENTIONAL_RE.test(line)) continue;
		if (i > 0 && INTENTIONAL_RE.test(lines[i - 1]!)) continue;

		// Exclude comparison operators that look like assignments: <=, >=, ==, ===, !==, !=, =>
		// The regex already excludes ==, but double-check for >=, <=
		const condMatch = trimmed.match(/\b(?:if|while)\s*\((.+)\)/);
		if (!condMatch) continue;
		const cond = condMatch[1]!;
		// If the only `=` signs are part of >=, <=, ==, ===, !==, !=, =>, skip
		const stripped = cond.replace(/(?:[!=<>]=|=>|===|!==)/g, "");
		if (!stripped.includes("=")) continue;

		errors.push(`L${i + 1}: Assignment (=) inside condition — use === for comparison`);
	}
	return errors;
}

// ── PBT advisory (non-blocking) ──────────────────────────────

const TEST_CASE_RE = /\b(?:it|test)\s*\(/g;
const PBT_IMPORT_RE = /(?:fast-check|@fast-check|fc\.|property\s*\(|forAll\s*\(|arbitrary)/;

function emitPbtAdvisory(file: string, content: string): void {
	try {
		const fileName = file.split("/").pop() ?? "";
		const isTestFile =
			fileName.includes(".test.") || fileName.includes(".spec.") || fileName.startsWith("test_");
		if (!isTestFile) return;

		const testCases = content.match(TEST_CASE_RE);
		if (!testCases || testCases.length < 5) return;
		if (PBT_IMPORT_RE.test(content)) return;

		const relative = file.split("/").slice(-3).join("/");
		process.stderr.write(
			`[qult] Advisory: ${relative} has ${testCases.length} test cases — consider property-based testing for broader coverage\n`,
		);
	} catch {
		/* fail-open */
	}
}

// ── Main export ───────────────────────────────────────────────

/** Detect silent failure patterns: code that compiles but is semantically wrong.
 *  Returns PendingFix[] (computational on_write sensor). */
export function detectSemanticPatterns(file: string): PendingFix[] {
	if (isGateDisabled("semantic-check")) return [];
	const ext = extname(file).toLowerCase();
	if (!CHECKABLE_EXTS.has(ext)) return [];
	if (!existsSync(file)) return [];

	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	if (content.length > MAX_CHECK_SIZE) return [];

	const lines = content.split("\n");
	const errors: string[] = [];

	// JS/TS specific checks
	if (JS_TS_EXTS.has(ext)) {
		errors.push(...detectEmptyCatch(lines));
		errors.push(...detectIgnoredReturn(lines));
		errors.push(...detectConditionAssignment(lines));
	}

	// Python empty except
	if (PY_EXTS.has(ext)) {
		errors.push(...detectEmptyCatch(lines));
	}

	// PBT advisory (non-blocking, stderr only)
	emitPbtAdvisory(file, content);

	if (errors.length === 0) return [];

	return [
		{
			file,
			errors: errors.map((e) => sanitizeForStderr(e.slice(0, 300))),
			gate: "semantic-check",
		},
	];
}
