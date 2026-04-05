import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { isTestFile, resolveTestFile } from "./test-file-resolver.ts";

/** Extensions to scan for import statements. */
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

/** Directories to skip during scanning. */
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	".next",
	".nuxt",
	"coverage",
	".git",
	".qult",
]);

/** Max file size to scan (256KB). */
const MAX_FILE_SIZE = 256 * 1024;

/** Max files to scan (performance bound). */
const MAX_FILES = 2000;

/** Max directory depth to prevent stack overflow. */
const MAX_DEPTH = 50;

/** Strip single-line and multi-line comments to avoid false positive import matches. */
function stripComments(content: string): string {
	return content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Extract relative import specifiers from file content.
 * Matches: import ... from "./foo", export ... from "../bar", require("./baz"), import("./qux")
 */
function extractRelativeImports(content: string): string[] {
	const stripped = stripComments(content);
	const specifiers: string[] = [];
	// import/export ... from "..." (handles single/double quotes)
	const esm = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
	// require("...")
	const cjs = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
	// dynamic import("...")
	const dynamic = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

	for (const match of stripped.matchAll(esm)) {
		specifiers.push(match[1]!);
	}
	for (const match of stripped.matchAll(cjs)) {
		specifiers.push(match[1]!);
	}
	for (const match of stripped.matchAll(dynamic)) {
		specifiers.push(match[1]!);
	}
	return specifiers;
}

/**
 * Resolve an import specifier to an absolute file path.
 * Handles extensionless imports (./foo → ./foo.ts, ./foo/index.ts).
 */
function resolveImportPath(specifier: string, fromFile: string): string | null {
	const dir = dirname(fromFile);
	const raw = resolve(dir, specifier);

	// Direct match (with extension)
	if (existsSync(raw) && statSync(raw).isFile()) return raw;

	// Try adding extensions
	for (const ext of SCAN_EXTS) {
		const withExt = `${raw}${ext}`;
		if (existsSync(withExt)) return withExt;
	}

	// Try index files
	for (const ext of SCAN_EXTS) {
		const index = join(raw, `index${ext}`);
		if (existsSync(index)) return index;
	}

	return null;
}

/**
 * Collect all scannable files under a directory (non-recursive past SKIP_DIRS).
 */
function collectFiles(dir: string): string[] {
	const files: string[] = [];
	let capped = false;

	function walk(current: string, depth: number): void {
		if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;

		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (files.length >= MAX_FILES) {
				capped = true;
				return;
			}
			if (SKIP_DIRS.has(entry)) continue;

			const full = join(current, entry);
			try {
				const stat = lstatSync(full);
				// Skip symlinks to prevent traversal outside project
				if (stat.isSymbolicLink()) continue;
				if (stat.isDirectory()) {
					walk(full, depth + 1);
				} else if (stat.isFile() && SCAN_EXTS.has(extname(full))) {
					if (stat.size <= MAX_FILE_SIZE) {
						files.push(full);
					}
				}
			} catch {
				/* skip unreadable */
			}
		}
	}

	walk(dir, 0);
	if (capped) {
		process.stderr.write(
			`[qult] import-graph: file scan capped at ${MAX_FILES} files, results may be incomplete\n`,
		);
	}
	return files;
}

/**
 * Find all files that import the target file (1-level depth only).
 * Scans all TS/JS files under scanRoot for relative imports that resolve to target.
 */
export function findImporters(targetFile: string, scanRoot: string): string[] {
	if (!existsSync(scanRoot)) return [];

	const targetAbs = resolve(targetFile);
	const files = collectFiles(scanRoot);
	const importers: string[] = [];

	for (const file of files) {
		if (resolve(file) === targetAbs) continue; // skip self

		try {
			const content = readFileSync(file, "utf-8");
			const specifiers = extractRelativeImports(content);

			for (const spec of specifiers) {
				const resolved = resolveImportPath(spec, file);
				if (resolved && resolve(resolved) === targetAbs) {
					importers.push(file);
					break; // one match is enough per file
				}
			}
		} catch {
			/* fail-open: skip unreadable files */
		}
	}

	return importers;
}

/**
 * Find test files affected by a change to the given file.
 * Strategy:
 * 1. Direct test file (foo.ts → foo.test.ts) via resolveTestFile
 * 2. Files that import the changed file → their test files via resolveTestFile
 *
 * Only 1-level depth (direct importers, not transitive).
 */
export function findAffectedTestFiles(changedFile: string, projectRoot: string): string[] {
	if (isTestFile(changedFile)) return [];

	const affected = new Set<string>();

	// 1. Direct test file
	try {
		const directTest = resolveTestFile(changedFile);
		if (directTest) affected.add(resolve(directTest));
	} catch {
		/* fail-open */
	}

	// 2. Find importers → their test files
	try {
		// Scan project root (covers src/, lib/, root-level files, etc.)
		const importers = findImporters(changedFile, projectRoot);

		for (const importer of importers) {
			// If the importer IS a test file, add it directly
			if (isTestFile(importer)) {
				affected.add(resolve(importer));
				continue;
			}

			// Otherwise find the importer's test file
			const importerTest = resolveTestFile(importer);
			if (importerTest) {
				affected.add(resolve(importerTest));
			}
		}
	} catch {
		/* fail-open */
	}

	return [...affected];
}
