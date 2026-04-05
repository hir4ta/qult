import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** Common test file patterns relative to source file location. */
const TEST_PATTERNS = [
	// Same directory: foo.test.ts, foo.spec.ts
	(dir: string, name: string, ext: string) => join(dir, `${name}.test${ext}`),
	(dir: string, name: string, ext: string) => join(dir, `${name}.spec${ext}`),
	// __tests__ directory: __tests__/foo.test.ts
	(dir: string, name: string, ext: string) => join(dir, "__tests__", `${name}.test${ext}`),
	(dir: string, name: string, ext: string) => join(dir, "__tests__", `${name}.spec${ext}`),
	// Sibling tests directory: tests/foo.test.ts
	(dir: string, name: string, ext: string) => join(dir, "tests", `${name}.test${ext}`),
	// Python: test_foo.py
	(dir: string, name: string, ext: string) =>
		ext === ".py" ? join(dir, `test_${name}${ext}`) : null,
	(dir: string, name: string, ext: string) =>
		ext === ".py" ? join(dir, "tests", `test_${name}${ext}`) : null,
	// Go: foo_test.go
	(dir: string, name: string, ext: string) =>
		ext === ".go" ? join(dir, `${name}_test${ext}`) : null,
	// Rust: tests directory
	(dir: string, name: string, ext: string) =>
		ext === ".rs" ? join(dir, "tests", `${name}${ext}`) : null,
];

/** Resolve the test file corresponding to a source file. Returns null if not found. */
export function resolveTestFile(sourceFile: string): string | null {
	const ext = extname(sourceFile);
	const base = basename(sourceFile, ext);
	const dir = dirname(sourceFile);

	// Skip if the file is already a test file
	if (isTestFile(sourceFile)) return null;

	for (const pattern of TEST_PATTERNS) {
		const candidate = pattern(dir, base, ext);
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

/** Check if a file path looks like a test file. */
export function isTestFile(file: string): boolean {
	const base = basename(file);
	return (
		/\.(test|spec)\.\w+$/.test(base) ||
		/^test_\w+\.py$/.test(base) ||
		/_test\.go$/.test(base) ||
		/\/(__tests__|tests)\//.test(file)
	);
}
