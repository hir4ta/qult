/**
 * Language filter for Living Spec auto-append.
 * Determines which source files should be tracked in design.md.
 */

import { basename, extname } from "node:path";

interface LangConfig {
	extensions: string[];
	excludeSuffixes: string[];
	excludePrefixes: string[];
}

const LANGUAGES: LangConfig[] = [
	{
		// JavaScript / TypeScript
		extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts"],
		excludeSuffixes: [
			".test.ts",
			".spec.ts",
			".test.js",
			".spec.js",
			".test.tsx",
			".spec.tsx",
			".test.mts",
			".spec.mts",
			".d.ts",
			".min.js",
			".bundle.js",
		],
		excludePrefixes: [],
	},
	{
		// Python
		extensions: [".py"],
		excludeSuffixes: ["_test.py", "_pb2.py", "_pb2_grpc.py"],
		excludePrefixes: ["test_", "conftest"],
	},
	{
		// Go
		extensions: [".go"],
		excludeSuffixes: ["_test.go", "_gen.go", ".pb.go", "_mock.go", "_string.go"],
		excludePrefixes: [],
	},
	{
		// Ruby
		extensions: [".rb"],
		excludeSuffixes: ["_test.rb", "_spec.rb"],
		excludePrefixes: [],
	},
	{
		// Rust
		extensions: [".rs"],
		excludeSuffixes: ["_test.rs", "_bench.rs", ".generated.rs"],
		excludePrefixes: ["test_"],
	},
	{
		// Java
		extensions: [".java"],
		excludeSuffixes: ["Test.java", "Tests.java", "IT.java"],
		excludePrefixes: [],
	},
	{
		// C#
		extensions: [".cs"],
		excludeSuffixes: [".Tests.cs", ".Test.cs", "Tests.cs"],
		excludePrefixes: [],
	},
	{
		// Swift
		extensions: [".swift"],
		excludeSuffixes: ["Tests.swift", "Spec.swift", "Test.swift"],
		excludePrefixes: [],
	},
	{
		// Kotlin
		extensions: [".kt", ".kts"],
		excludeSuffixes: ["Test.kt", "Tests.kt", "Test.kts"],
		excludePrefixes: [],
	},
];

const DIR_EXCLUSIONS = [
	"vendor/",
	"node_modules/",
	".alfred/",
	"dist/",
	"build/",
	"__pycache__/",
	".venv/",
	"plugin/",
	"tests/",
	"src/test/",
	".build/",
	"obj/",
	"bin/",
];

/** Check if a source file should be auto-appended to design.md. */
export function shouldAutoAppend(filePath: string): boolean {
	// Directory exclusions.
	for (const dir of DIR_EXCLUSIONS) {
		if (filePath.startsWith(dir) || filePath.includes(`/${dir}`)) return false;
	}

	const ext = extname(filePath);
	const name = basename(filePath);

	for (const lang of LANGUAGES) {
		if (!lang.extensions.includes(ext)) continue;

		// Check suffix exclusions.
		for (const suffix of lang.excludeSuffixes) {
			if (filePath.endsWith(suffix)) return false;
		}

		// Check prefix exclusions (on basename).
		for (const prefix of lang.excludePrefixes) {
			if (name.startsWith(prefix)) return false;
		}

		return true;
	}

	return false;
}
