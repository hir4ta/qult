import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findAffectedTestFiles, findImporters } from "../hooks/detectors/import-graph.ts";

const TEST_DIR = join(tmpdir(), ".qult-import-graph-test");

beforeEach(() => {
	mkdirSync(join(TEST_DIR, "src"), { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("findImporters", () => {
	it("finds files that import the target via relative path", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const importer = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(importer, 'import { foo } from "./utils";');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toHaveLength(1);
		expect(result).toContain(importer);
	});

	it("finds files that import with .ts extension", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const importer = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(importer, 'import { foo } from "./utils.ts";');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toContain(importer);
	});

	it("finds files using require()", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const importer = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "module.exports = {};");
		writeFileSync(importer, 'const u = require("./utils");');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toContain(importer);
	});

	it("finds files that re-export from target", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const reexporter = join(TEST_DIR, "src", "index.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(reexporter, 'export { foo } from "./utils";');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toContain(reexporter);
	});

	it("ignores non-matching imports", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const other = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(other, 'import { bar } from "./other";');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).not.toContain(other);
	});

	it("handles subdirectory imports", () => {
		mkdirSync(join(TEST_DIR, "src", "lib"), { recursive: true });
		const target = join(TEST_DIR, "src", "lib", "helper.ts");
		const importer = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "export const help = 1;");
		writeFileSync(importer, 'import { help } from "./lib/helper";');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toContain(importer);
	});

	it("handles parent directory imports", () => {
		mkdirSync(join(TEST_DIR, "src", "sub"), { recursive: true });
		const target = join(TEST_DIR, "src", "utils.ts");
		const importer = join(TEST_DIR, "src", "sub", "child.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(importer, 'import { foo } from "../utils";');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toContain(importer);
	});

	it("returns empty array when no importers found", () => {
		const target = join(TEST_DIR, "src", "lonely.ts");
		writeFileSync(target, "export const x = 1;");

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toEqual([]);
	});

	it("skips node_modules", () => {
		mkdirSync(join(TEST_DIR, "src", "node_modules", "pkg"), { recursive: true });
		const target = join(TEST_DIR, "src", "utils.ts");
		const nmFile = join(TEST_DIR, "src", "node_modules", "pkg", "index.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(nmFile, 'import { foo } from "../../utils";');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).not.toContain(nmFile);
	});

	it("skips dist and build directories", () => {
		mkdirSync(join(TEST_DIR, "src", "dist"), { recursive: true });
		const target = join(TEST_DIR, "src", "utils.ts");
		const distFile = join(TEST_DIR, "src", "dist", "bundle.js");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(distFile, 'import { foo } from "../utils";');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).not.toContain(distFile);
	});

	it("ignores imports inside comments", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const file = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(file, '// import { foo } from "./utils";\nconst x = 1;');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toHaveLength(0);
	});

	it("ignores imports inside block comments", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const file = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(file, '/* import { foo } from "./utils"; */\nconst x = 1;');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toHaveLength(0);
	});

	it("finds dynamic import() calls", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const importer = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(importer, 'const mod = import("./utils");');

		const result = findImporters(target, join(TEST_DIR, "src"));
		expect(result).toHaveLength(1);
		expect(result).toContain(importer);
	});
});

describe("findAffectedTestFiles", () => {
	it("finds test files that import the changed file", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const testFile = join(TEST_DIR, "src", "utils.test.ts");
		const indirectTest = join(TEST_DIR, "src", "app.test.ts");
		const app = join(TEST_DIR, "src", "app.ts");

		writeFileSync(target, "export const foo = 1;");
		writeFileSync(testFile, 'import { foo } from "./utils";');
		writeFileSync(app, 'import { foo } from "./utils";');
		writeFileSync(indirectTest, 'import { something } from "./app";');

		const result = findAffectedTestFiles(target, TEST_DIR);
		// Direct test file for utils
		expect(result).toContain(testFile);
		// app.ts imports utils → app.test.ts is affected (importer's test file)
		expect(result).toContain(indirectTest);
	});

	it("includes direct test file even if it doesn't import target", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const testFile = join(TEST_DIR, "src", "utils.test.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(testFile, "// test file with no imports");

		const result = findAffectedTestFiles(target, TEST_DIR);
		expect(result).toContain(testFile);
	});

	it("finds test files among importers of the changed file", () => {
		const target = join(TEST_DIR, "src", "types.ts");
		const consumer = join(TEST_DIR, "src", "service.ts");
		const consumerTest = join(TEST_DIR, "src", "service.test.ts");

		writeFileSync(target, "export type Foo = {};");
		writeFileSync(consumer, 'import type { Foo } from "./types";');
		writeFileSync(consumerTest, 'import { doStuff } from "./service";');

		// service.ts imports types.ts, service.test.ts imports service.ts
		// findImporters finds service.ts as importer of types.ts
		// Then resolveTestFile(service.ts) → service.test.ts
		const result = findAffectedTestFiles(target, TEST_DIR);
		expect(result).toContain(consumerTest);
	});

	it("returns empty for test files themselves", () => {
		const testFile = join(TEST_DIR, "src", "foo.test.ts");
		writeFileSync(testFile, "");

		const result = findAffectedTestFiles(testFile, TEST_DIR);
		expect(result).toEqual([]);
	});

	it("deduplicates results", () => {
		const target = join(TEST_DIR, "src", "utils.ts");
		const testFile = join(TEST_DIR, "src", "utils.test.ts");

		writeFileSync(target, "export const foo = 1;");
		// Test file also imports the target directly
		writeFileSync(testFile, 'import { foo } from "./utils";');

		const result = findAffectedTestFiles(target, TEST_DIR);
		const unique = [...new Set(result)];
		expect(result).toEqual(unique);
	});

	it("returns empty when no importers exist", () => {
		const target = join(TEST_DIR, "src", "lonely.ts");
		writeFileSync(target, "export const x = 1;");

		const result = findAffectedTestFiles(target, TEST_DIR);
		expect(result).toEqual([]);
	});

	it("finds importers outside src/ via projectRoot scan", () => {
		mkdirSync(join(TEST_DIR, "lib"), { recursive: true });
		const target = join(TEST_DIR, "src", "shared.ts");
		const libFile = join(TEST_DIR, "lib", "consumer.ts");
		const libTest = join(TEST_DIR, "lib", "consumer.test.ts");

		writeFileSync(target, "export const shared = 1;");
		writeFileSync(libFile, 'import { shared } from "../src/shared";');
		writeFileSync(libTest, 'import { consumer } from "./consumer";');

		const result = findAffectedTestFiles(target, TEST_DIR);
		expect(result).toContain(libTest);
	});
});
