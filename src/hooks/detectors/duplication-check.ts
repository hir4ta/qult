import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { isGateDisabled } from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";

const CHECKABLE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".mjs",
	".cjs",
	".py",
	".pyi",
	".go",
	".rs",
	".rb",
	".java",
	".kt",
]);

const MAX_CHECK_SIZE = 500_000;
const MIN_BLOCK_LINES = 4;
const MAX_SESSION_FILES = 20;

/** Normalize a line for duplication comparison: trim whitespace, skip blanks and comments. */
function normalizeLine(line: string): string | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	if (trimmed.startsWith("//") || trimmed.startsWith("#")) return null;
	// Block comment lines: "* text", "*/", "/*", bare "*" (JSDoc body)
	if (trimmed.startsWith("* ") || trimmed.startsWith("*/") || trimmed === "*") return null;
	if (trimmed.startsWith("/*")) return null;
	// Skip import/require/export lines (commonly duplicated by necessity)
	if (/^\s*(import\b|from\b|require\b|export\b)/.test(line)) return null;
	return trimmed;
}

/** Build hash windows for a file's normalized lines. Returns Map<hash, line numbers[]>. */
function buildHashWindows(content: string): Map<string, number[]> {
	const lines = content.split("\n");
	const normalized: { line: number; text: string }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const norm = normalizeLine(lines[i]!);
		if (norm !== null) {
			normalized.push({ line: i + 1, text: norm });
		}
	}

	const windows = new Map<string, number[]>();
	for (let i = 0; i <= normalized.length - MIN_BLOCK_LINES; i++) {
		const key = normalized
			.slice(i, i + MIN_BLOCK_LINES)
			.map((n) => n.text)
			.join("\n");
		const startLine = normalized[i]!.line;
		const existing = windows.get(key);
		if (existing) {
			existing.push(startLine);
		} else {
			windows.set(key, [startLine]);
		}
	}

	return windows;
}

/** Detect duplicate code blocks within a single file.
 *  Returns PendingFix[] (blocking) for intra-file duplication. */
export function detectDuplication(file: string): PendingFix[] {
	if (isGateDisabled("duplication-check")) return [];
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

	const windows = buildHashWindows(content);
	const errors: string[] = [];
	const reported = new Set<string>();

	for (const [hash, positions] of windows) {
		if (positions.length < 2) continue;
		// Deduplicate overlapping windows
		const key = `${positions[0]}-${positions[1]}`;
		if (reported.has(key)) continue;
		reported.add(key);

		const preview = hash.split("\n")[0]!.slice(0, 80);
		errors.push(
			`Intra-file duplicate (${MIN_BLOCK_LINES}+ lines) at L${positions[0]} and L${positions[1]}: "${preview}..."`,
		);
	}

	if (errors.length === 0) return [];
	return [{ file, errors, gate: "duplication-check" }];
}

/** Detect duplicate code blocks across files.
 *  Returns advisory warning strings (non-blocking). */
export function detectCrossFileDuplication(file: string, sessionFiles: string[]): string[] {
	if (isGateDisabled("duplication-check")) return [];
	if (sessionFiles.length > MAX_SESSION_FILES) {
		// Fail-open with transparent warning: user must know check was skipped
		process.stderr.write(
			`[qult] Cross-file duplication check skipped: session has ${sessionFiles.length} files, max ${MAX_SESSION_FILES} allowed. Increase MAX_SESSION_FILES to enable on large refactorings.\n`,
		);
		return [];
	}
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

	const sourceWindows = buildHashWindows(content);
	const warnings: string[] = [];

	const cwd = process.cwd();
	for (const otherFile of sessionFiles) {
		if (otherFile === file) continue;
		// Path traversal prevention: reject paths outside project root
		const absOther = resolve(otherFile);
		if (!absOther.startsWith(`${cwd}/`)) continue;
		if (!existsSync(otherFile)) continue;
		const otherExt = extname(otherFile).toLowerCase();
		if (!CHECKABLE_EXTS.has(otherExt)) continue;

		let otherContent: string;
		try {
			otherContent = readFileSync(otherFile, "utf-8");
		} catch {
			continue;
		}
		if (otherContent.length > MAX_CHECK_SIZE) continue;

		const otherWindows = buildHashWindows(otherContent);
		let matchCount = 0;

		for (const hash of sourceWindows.keys()) {
			if (otherWindows.has(hash)) {
				matchCount++;
			}
		}

		// Report all matches found, not just first match (prevents silent under-reporting)
		if (matchCount > 0) {
			const relPath = getRelativePath(otherFile, cwd);
			const preview = Array.from(sourceWindows.keys())[0]!.split("\n")[0]!.slice(0, 80);
			const blockCountLabel = matchCount === 1 ? "block" : "blocks";
			warnings.push(
				`Cross-file duplicate with ${relPath}: ${matchCount} matching ${blockCountLabel} found. Preview: "${preview}..."`,
			);
		}
	}

	return warnings;
}

/** Get a readable relative path: if ≤3 segments, show full; else show abbreviated form. */
function getRelativePath(filePath: string, cwd: string): string {
	const full = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
	const segments = full.split("/");
	if (segments.length <= 3) return full;
	// For deep paths, show first and last 2 segments: "src/.../deep/nested/file.ts"
	return `${segments[0]}/.../.../${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}
