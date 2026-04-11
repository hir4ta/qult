import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { isTestFile, resolveTestFile } from "./test-file-resolver.ts";

/** Extensions to scan for import statements. */
const SCAN_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
]);

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
	"__pycache__",
	".venv",
	"venv",
	"target", // Rust
	"vendor", // Go
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
 * Supports: TS/JS (ESM/CJS/dynamic), Python (from .X import), Go (internal packages), Rust (mod/use crate::)
 */
function extractRelativeImports(content: string, filePath?: string): string[] {
	const stripped = stripComments(content);
	const specifiers: string[] = [];
	const ext = filePath ? extname(filePath).toLowerCase() : "";

	if (ext === ".py") {
		// Python: from .module import X, from ..module import Y, from . import X
		const pyRel = /from\s+(\.[\w.]*)\s+import/g;
		for (const match of stripped.matchAll(pyRel)) {
			specifiers.push(match[1]!);
		}
		return specifiers;
	}

	if (ext === ".go") {
		// Go: import "module/path/pkg" — internal packages only (resolved in findImporters)
		// Single import
		const goSingle = /import\s+"([^"]+)"/g;
		for (const match of stripped.matchAll(goSingle)) {
			specifiers.push(match[1]!);
		}
		// Multi-line import block
		const goBlock = /import\s*\(([\s\S]*?)\)/g;
		for (const block of stripped.matchAll(goBlock)) {
			const lines = block[1]!;
			const lineRe = /\s*(?:\w+\s+)?"([^"]+)"/g;
			for (const m of lines.matchAll(lineRe)) {
				specifiers.push(m[1]!);
			}
		}
		return specifiers;
	}

	if (ext === ".rs") {
		// Rust: mod foo; → foo.rs or foo/mod.rs
		const modDecl = /\bmod\s+(\w+)\s*;/g;
		for (const match of stripped.matchAll(modDecl)) {
			specifiers.push(`mod:${match[1]!}`);
		}
		// Rust: use crate::foo::bar → foo
		const useCrate = /\buse\s+crate::(\w+)/g;
		for (const match of stripped.matchAll(useCrate)) {
			specifiers.push(`crate:${match[1]!}`);
		}
		return specifiers;
	}

	// TS/JS: ESM, CJS, dynamic import
	const esm = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
	const cjs = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
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
 * Resolve a Python relative import specifier to an absolute file path.
 * from .utils import X → ./utils.py, from . import utils → ./utils.py
 */
function resolvePythonImport(specifier: string, fromFile: string): string | null {
	const dir = dirname(fromFile);
	// Count leading dots to determine relative depth
	const dotMatch = specifier.match(/^(\.+)(.*)/);
	if (!dotMatch) return null;
	const dots = dotMatch[1]!.length;
	const modulePart = dotMatch[2]!; // e.g. "utils" or "pkg.sub" or ""

	// Go up (dots-1) directories (1 dot = current dir)
	let base = dir;
	for (let i = 1; i < dots; i++) {
		base = dirname(base);
	}

	if (!modulePart) {
		// from . import utils → could be any module in the package
		return null; // handled as same-package reference in findImporters
	}

	// Convert dot-separated module path to file path
	const parts = modulePart.split(".");
	const candidate = join(base, ...parts);

	// Try as file
	if (existsSync(`${candidate}.py`)) return `${candidate}.py`;
	// Try as package
	if (existsSync(join(candidate, "__init__.py"))) return join(candidate, "__init__.py");

	return null;
}

/**
 * Resolve a Rust import specifier to an absolute file path.
 * mod foo; → foo.rs or foo/mod.rs (relative to declaring file)
 * use crate::foo → src/foo.rs or src/foo/mod.rs
 */
function resolveRustImport(specifier: string, fromFile: string, scanRoot: string): string | null {
	const dir = dirname(fromFile);
	if (specifier.startsWith("mod:")) {
		const name = specifier.slice(4);
		// mod foo; → sibling foo.rs or foo/mod.rs
		const asFile = join(dir, `${name}.rs`);
		if (existsSync(asFile)) return asFile;
		const asDir = join(dir, name, "mod.rs");
		if (existsSync(asDir)) return asDir;
	} else if (specifier.startsWith("crate:")) {
		const name = specifier.slice(6);
		// use crate::foo → src/foo.rs or src/foo/mod.rs
		const srcDir = join(scanRoot, "src");
		const asFile = join(srcDir, `${name}.rs`);
		if (existsSync(asFile)) return asFile;
		const asDir = join(srcDir, name, "mod.rs");
		if (existsSync(asDir)) return asDir;
	}
	return null;
}

/** Reset Go module cache (for testing). */
export function _resetGoModuleCache(): void {
	_goModuleCache = undefined;
}

/** Read go.mod module path from project root, cached per process. */
let _goModuleCache: string | null | undefined;
function getGoModulePath(scanRoot: string): string | null {
	if (_goModuleCache !== undefined) return _goModuleCache;
	try {
		const goMod = readFileSync(join(scanRoot, "go.mod"), "utf-8");
		const match = goMod.match(/^module\s+(\S+)/m);
		_goModuleCache = match ? match[1]! : null;
	} catch {
		_goModuleCache = null;
	}
	return _goModuleCache;
}

/**
 * Resolve a Go import specifier to an absolute file path (directory).
 * Only resolves internal packages (matching go.mod module path).
 */
function resolveGoImport(specifier: string, scanRoot: string): string | null {
	const modulePath = getGoModulePath(scanRoot);
	if (!modulePath || !specifier.startsWith(modulePath)) return null;
	const relPath = specifier.slice(modulePath.length + 1); // strip "module/" prefix
	const dir = join(scanRoot, relPath);
	if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
	return null;
}

/**
 * Resolve an import specifier to an absolute file path.
 * Handles extensionless imports (./foo → ./foo.ts, ./foo/index.ts).
 */
function resolveImportPath(specifier: string, fromFile: string, scanRoot?: string): string | null {
	const fileExt = extname(fromFile).toLowerCase();

	// Python relative imports
	if (fileExt === ".py") {
		return resolvePythonImport(specifier, fromFile);
	}

	// Rust mod/crate imports
	if (fileExt === ".rs" && scanRoot) {
		return resolveRustImport(specifier, fromFile, scanRoot);
	}

	// Go internal package imports
	if (fileExt === ".go" && scanRoot) {
		return resolveGoImport(specifier, scanRoot);
	}

	// TS/JS resolution
	const dir = dirname(fromFile);
	const raw = resolve(dir, specifier);

	// Direct match (with extension)
	if (existsSync(raw) && statSync(raw).isFile()) return raw;

	// Try adding extensions
	for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
		const withExt = `${raw}${ext}`;
		if (existsSync(withExt)) return withExt;
	}

	// Try index files
	for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
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
 * Find all files that import the target file.
 * @param depth - How many levels of transitive importers to follow (default 1, max 3).
 */
export function findImporters(targetFile: string, scanRoot: string, depth = 1): string[] {
	if (!existsSync(scanRoot)) return [];
	const clampedDepth = Math.min(Math.max(depth, 1), 3);
	const files = collectFiles(scanRoot);
	const visited = new Set<string>();
	const allImporters: string[] = [];

	function findDirectImporters(targetAbs: string): string[] {
		const direct: string[] = [];
		const targetDir = dirname(targetAbs);
		const targetExt = extname(targetAbs).toLowerCase();

		for (const file of files) {
			const fileAbs = resolve(file);
			if (fileAbs === targetAbs) continue;

			// Go: files in the same package directory are implicit importers
			if (
				targetExt === ".go" &&
				extname(file).toLowerCase() === ".go" &&
				dirname(fileAbs) === targetDir
			) {
				direct.push(file);
				continue;
			}

			try {
				const content = readFileSync(file, "utf-8");
				const specifiers = extractRelativeImports(content, file);

				for (const spec of specifiers) {
					const resolved = resolveImportPath(spec, file, scanRoot);
					if (!resolved) continue;

					// For Go, resolved is a directory — check if target is in that directory
					if (extname(file).toLowerCase() === ".go") {
						if (resolve(resolved) === targetDir) {
							direct.push(file);
							break;
						}
					} else if (resolve(resolved) === targetAbs) {
						direct.push(file);
						break;
					}
				}
			} catch {
				/* fail-open */
			}
		}

		// Python: from . import X — match files in same package as target
		if (targetExt === ".py") {
			const targetName = targetAbs.replace(/\.py$/, "").split("/").pop()!;
			for (const file of files) {
				const fileAbs = resolve(file);
				if (fileAbs === targetAbs || direct.includes(file)) continue;
				if (extname(file).toLowerCase() !== ".py") continue;
				try {
					const content = readFileSync(file, "utf-8");
					// from . import utils → matches if target is utils.py in same dir
					const bareImport = new RegExp(`from\\s+\\.\\s+import\\s+(?:.*\\b${targetName}\\b)`, "m");
					if (bareImport.test(content) && dirname(fileAbs) === targetDir) {
						direct.push(file);
					}
				} catch {
					/* fail-open */
				}
			}
		}

		return direct;
	}

	// BFS for transitive importers
	let currentTargets = [resolve(targetFile)];
	for (let d = 0; d < clampedDepth; d++) {
		const nextTargets: string[] = [];
		for (const target of currentTargets) {
			if (visited.has(target)) continue;
			visited.add(target);
			const direct = findDirectImporters(target);
			for (const imp of direct) {
				const impAbs = resolve(imp);
				if (!visited.has(impAbs) && impAbs !== resolve(targetFile)) {
					allImporters.push(imp);
					nextTargets.push(impAbs);
				}
			}
		}
		currentTargets = nextTargets;
		if (!currentTargets.length) break;
	}

	// Deduplicate
	return [...new Set(allImporters)];
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
