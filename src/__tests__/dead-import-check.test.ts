import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-dead-import-test");
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("detectDeadImports: TypeScript/JavaScript", () => {
	async function detect(file: string) {
		const { detectDeadImports } = await import("../hooks/detectors/dead-import-check.ts");
		return detectDeadImports(file);
	}

	it("detects unused default import", async () => {
		const file = join(TEST_DIR, "unused-default.ts");
		writeFileSync(
			file,
			`import React from "react";
import { useState } from "react";

export function App() {
  const [x, setX] = useState(0);
  return x;
}
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("React");
		expect(warnings[0]).toContain("unused");
	});

	it("detects unused named import", async () => {
		const file = join(TEST_DIR, "unused-named.ts");
		writeFileSync(
			file,
			`import { foo, bar } from "./utils";

console.log(foo());
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("bar");
	});

	it("detects unused namespace import", async () => {
		const file = join(TEST_DIR, "unused-ns.ts");
		writeFileSync(
			file,
			`import * as helpers from "./helpers";

const x = 1;
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("helpers");
	});

	it("handles aliased imports correctly", async () => {
		const file = join(TEST_DIR, "aliased.ts");
		writeFileSync(
			file,
			`import { foo as bar } from "./utils";

console.log(bar);
`,
		);
		const warnings = await detect(file);
		// bar is used, should have no warnings
		expect(warnings.length).toBe(0);
	});

	it("handles aliased import where alias is unused", async () => {
		const file = join(TEST_DIR, "aliased-unused.ts");
		writeFileSync(
			file,
			`import { foo as bar } from "./utils";

console.log("hello");
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("bar");
	});

	it("skips side-effect imports", async () => {
		const file = join(TEST_DIR, "sideeffect.ts");
		writeFileSync(
			file,
			`import "reflect-metadata";

const x = 1;
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(0);
	});

	it("skips re-exports", async () => {
		const file = join(TEST_DIR, "reexport.ts");
		writeFileSync(
			file,
			`export { foo } from "./utils";

const x = 1;
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(0);
	});

	it("handles type-only imports", async () => {
		const file = join(TEST_DIR, "type-import.ts");
		writeFileSync(
			file,
			`import type { Foo, Bar } from "./types";

const x: Foo = {};
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("Bar");
	});

	it("returns empty for all-used imports", async () => {
		const file = join(TEST_DIR, "all-used.ts");
		writeFileSync(
			file,
			`import { readFileSync, writeFileSync } from "node:fs";

const content = readFileSync("f", "utf-8");
writeFileSync("g", content);
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(0);
	});
});

describe("detectDeadImports: Python", () => {
	async function detect(file: string) {
		const { detectDeadImports } = await import("../hooks/detectors/dead-import-check.ts");
		return detectDeadImports(file);
	}

	it("detects unused Python import", async () => {
		const file = join(TEST_DIR, "unused.py");
		writeFileSync(
			file,
			`import os
import sys

print(sys.argv)
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("os");
	});

	it("detects unused from-import", async () => {
		const file = join(TEST_DIR, "from-unused.py");
		writeFileSync(
			file,
			`from typing import List, Dict

x: List[int] = []
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("Dict");
	});

	it("handles Python as-import", async () => {
		const file = join(TEST_DIR, "as-import.py");
		writeFileSync(
			file,
			`import numpy as np

print("hello")
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("np");
	});

	it("returns empty when all used", async () => {
		const file = join(TEST_DIR, "all-used.py");
		writeFileSync(
			file,
			`from os.path import join, exists

result = join("a", "b")
if exists(result):
    pass
`,
		);
		const warnings = await detect(file);
		expect(warnings.length).toBe(0);
	});
});

describe("detectDeadImports: edge cases", () => {
	async function detect(file: string) {
		const { detectDeadImports } = await import("../hooks/detectors/dead-import-check.ts");
		return detectDeadImports(file);
	}

	it("returns empty for non-supported extensions", async () => {
		const file = join(TEST_DIR, "data.json");
		writeFileSync(file, `{}`);
		const warnings = await detect(file);
		expect(warnings.length).toBe(0);
	});

	it("returns empty for missing file", async () => {
		const warnings = await detect(join(TEST_DIR, "nope.ts"));
		expect(warnings.length).toBe(0);
	});
});

describe("detectHallucinatedImports: Python site-packages (Task 10)", () => {
	async function detect(file: string) {
		const { detectHallucinatedImports } = await import("../hooks/detectors/import-check.ts");
		return detectHallucinatedImports(file);
	}

	it("skips underscore-prefixed modules (_thread, _collections_abc)", async () => {
		const file = join(TEST_DIR, "internal.py");
		writeFileSync(
			file,
			`import _thread
import _collections_abc

_thread.start_new_thread(lambda: None, ())
`,
		);
		const fixes = await detect(file);
		// _thread and _collections_abc are internal C modules — should not be flagged
		expect(fixes.length).toBe(0);
	});

	it("does not flag module found in .venv site-packages", async () => {
		// Create a fake .venv/lib/python3.11/site-packages/mypackage directory
		const sitePackages = join(TEST_DIR, ".venv", "lib", "python3.11", "site-packages");
		mkdirSync(join(sitePackages, "mypackage"), { recursive: true });

		const file = join(TEST_DIR, "use_pkg.py");
		writeFileSync(file, `import mypackage\n\nmypackage.run()\n`);

		const fixes = await detect(file);
		expect(fixes.length).toBe(0);
	});

	it("does not flag module found in venv (without dot) site-packages", async () => {
		const sitePackages = join(TEST_DIR, "venv", "lib", "python3.10", "site-packages");
		mkdirSync(join(sitePackages, "another_lib"), { recursive: true });

		const file = join(TEST_DIR, "use_lib.py");
		writeFileSync(file, `import another_lib\n\nanother_lib.init()\n`);

		const fixes = await detect(file);
		expect(fixes.length).toBe(0);
	});

	it("still flags genuinely missing module not in site-packages", async () => {
		const file = join(TEST_DIR, "missing_pkg.py");
		writeFileSync(file, `import totally_fake_package_xyz\n\ntotally_fake_package_xyz.run()\n`);

		const fixes = await detect(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("totally_fake_package_xyz");
	});
});
