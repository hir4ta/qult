import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-semantic-check-test");

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(join(TEST_DIR, "src"), { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

async function detect(file: string) {
	const { detectSemanticPatterns } = await import("../hooks/detectors/semantic-check.ts");
	return detectSemanticPatterns(file);
}

describe("Unreachable code after return", () => {
	it("detects code after return statement", async () => {
		const file = join(TEST_DIR, "src/unreachable.ts");
		writeFileSync(
			file,
			`function foo() {
  return x;
  doSomething();
}
`,
		);
		const fixes = await detect(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("Unreachable code");
	});

	it("does NOT detect closing brace after return", async () => {
		const file = join(TEST_DIR, "src/ok-return.ts");
		writeFileSync(
			file,
			`function foo() {
  return x;
}
`,
		);
		const fixes = await detect(file);
		const unreachable = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Unreachable"));
		expect(unreachable.length).toBe(0);
	});

	it("detects code after throw statement", async () => {
		const file = join(TEST_DIR, "src/throw.ts");
		writeFileSync(
			file,
			`function foo() {
  throw new Error("fail");
  cleanup();
}
`,
		);
		const fixes = await detect(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("Unreachable code");
	});

	it("allows suppression with intentional comment", async () => {
		const file = join(TEST_DIR, "src/intentional.ts");
		writeFileSync(
			file,
			`function foo() {
  return x;
  doSomething(); // intentional
}
`,
		);
		const fixes = await detect(file);
		const unreachable = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Unreachable"));
		expect(unreachable.length).toBe(0);
	});
});

describe("Loose equality detection", () => {
	it("detects == in condition", async () => {
		const file = join(TEST_DIR, "src/loose.ts");
		writeFileSync(
			file,
			`if (x == y) {
  doSomething();
}
`,
		);
		const fixes = await detect(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("Loose equality");
	});

	it("detects != in condition", async () => {
		const file = join(TEST_DIR, "src/loose-ne.ts");
		writeFileSync(
			file,
			`if (x != y) {
  doSomething();
}
`,
		);
		const fixes = await detect(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("Loose equality");
	});

	it("does NOT detect == null (intentional null coalescing)", async () => {
		const file = join(TEST_DIR, "src/null-check.ts");
		writeFileSync(
			file,
			`if (x == null) {
  doDefault();
}
if (y != null) {
  use(y);
}
`,
		);
		const fixes = await detect(file);
		const loose = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Loose equality"));
		expect(loose.length).toBe(0);
	});

	it("does NOT detect === or !==", async () => {
		const file = join(TEST_DIR, "src/strict.ts");
		writeFileSync(
			file,
			`if (x === y) {
  doSomething();
}
if (a !== b) {
  doOther();
}
`,
		);
		const fixes = await detect(file);
		const loose = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Loose equality"));
		expect(loose.length).toBe(0);
	});

	it("does NOT detect loose equality in non-JS files", async () => {
		const file = join(TEST_DIR, "src/script.py");
		writeFileSync(
			file,
			`if x == y:
    do_something()
`,
		);
		const fixes = await detect(file);
		const loose = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Loose equality"));
		expect(loose.length).toBe(0);
	});
});

describe("Switch fallthrough detection", () => {
	it("detects fallthrough without break", async () => {
		const file = join(TEST_DIR, "src/fallthrough.ts");
		writeFileSync(
			file,
			`switch (x) {
  case 1:
    foo();
  case 2:
    bar();
    break;
}
`,
		);
		const fixes = await detect(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("fallthrough");
	});

	it("does NOT detect case with break", async () => {
		const file = join(TEST_DIR, "src/with-break.ts");
		writeFileSync(
			file,
			`switch (x) {
  case 1:
    foo();
    break;
  case 2:
    bar();
    break;
}
`,
		);
		const fixes = await detect(file);
		const fallthrough = fixes.flatMap((f) => f.errors).filter((e) => e.includes("fallthrough"));
		expect(fallthrough.length).toBe(0);
	});

	it("does NOT detect case with // fallthrough comment", async () => {
		const file = join(TEST_DIR, "src/comment-fallthrough.ts");
		writeFileSync(
			file,
			`switch (x) {
  case 1:
    foo();
    // fallthrough
  case 2:
    bar();
    break;
}
`,
		);
		const fixes = await detect(file);
		const fallthrough = fixes.flatMap((f) => f.errors).filter((e) => e.includes("fallthrough"));
		expect(fallthrough.length).toBe(0);
	});

	it("does NOT detect case with /* fallthrough */ comment", async () => {
		const file = join(TEST_DIR, "src/block-comment-fallthrough.ts");
		writeFileSync(
			file,
			`switch (x) {
  case 1:
    foo();
    /* fallthrough */
  case 2:
    bar();
    break;
}
`,
		);
		const fixes = await detect(file);
		const fallthrough = fixes.flatMap((f) => f.errors).filter((e) => e.includes("fallthrough"));
		expect(fallthrough.length).toBe(0);
	});

	it("does NOT detect case with return", async () => {
		const file = join(TEST_DIR, "src/with-return.ts");
		writeFileSync(
			file,
			`switch (x) {
  case 1:
    return foo();
  case 2:
    return bar();
}
`,
		);
		const fixes = await detect(file);
		const fallthrough = fixes.flatMap((f) => f.errors).filter((e) => e.includes("fallthrough"));
		expect(fallthrough.length).toBe(0);
	});

	it("allows suppression with intentional comment", async () => {
		const file = join(TEST_DIR, "src/intentional-fall.ts");
		writeFileSync(
			file,
			`switch (x) {
  case 1:
    foo(); // intentional
  case 2:
    bar();
    break;
}
`,
		);
		const fixes = await detect(file);
		const fallthrough = fixes.flatMap((f) => f.errors).filter((e) => e.includes("fallthrough"));
		expect(fallthrough.length).toBe(0);
	});
});

describe("Switch fallthrough — nested block and default fixes", () => {
	it("detects fallthrough when case body contains a nested block (if/for)", async () => {
		const file = join(TEST_DIR, "src/nested-block-fallthrough.ts");
		writeFileSync(
			file,
			`switch (x) {
  case 1:
    if (cond) {
      doA();
    }
  case 2:
    doB();
    break;
}
`,
		);
		const fixes = await detect(file);
		const fallthrough = fixes.flatMap((f) => f.errors).filter((e) => e.includes("fallthrough"));
		expect(fallthrough.length).toBe(1);
		expect(fallthrough[0]).toContain("L6");
	});

	it("detects fallthrough from case into default", async () => {
		const file = join(TEST_DIR, "src/case-to-default.ts");
		writeFileSync(
			file,
			`switch (x) {
  case 1:
    doSomething();
  default:
    doDefault();
}
`,
		);
		const fixes = await detect(file);
		const fallthrough = fixes.flatMap((f) => f.errors).filter((e) => e.includes("fallthrough"));
		expect(fallthrough.length).toBe(1);
		expect(fallthrough[0]).toContain("L4");
	});

	it("does NOT flag case with if-block and explicit break", async () => {
		const file = join(TEST_DIR, "src/if-block-break.ts");
		writeFileSync(
			file,
			`switch (x) {
  case 1:
    if (cond) {
      doA();
    }
    break;
  case 2:
    doB();
    break;
}
`,
		);
		const fixes = await detect(file);
		const fallthrough = fixes.flatMap((f) => f.errors).filter((e) => e.includes("fallthrough"));
		expect(fallthrough.length).toBe(0);
	});
});

describe("Loose equality — string literal suppression", () => {
	it("does NOT flag == inside a string literal", async () => {
		const file = join(TEST_DIR, "src/loose-in-string.ts");
		writeFileSync(file, `expect(msg).toBe("values are not == in length");\n`);
		const fixes = await detect(file);
		const loose = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Loose equality"));
		expect(loose.length).toBe(0);
	});

	it("does NOT flag != inside a string literal", async () => {
		const file = join(TEST_DIR, "src/loose-in-string-ne.ts");
		writeFileSync(file, `const desc = "status != 200 is an error";\n`);
		const fixes = await detect(file);
		const loose = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Loose equality"));
		expect(loose.length).toBe(0);
	});

	it("still detects real loose equality on the same line as a string", async () => {
		const file = join(TEST_DIR, "src/loose-mixed.ts");
		writeFileSync(file, `if (a != b && label === "check != here") { doX(); }\n`);
		const fixes = await detect(file);
		const loose = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Loose equality"));
		expect(loose.length).toBe(1);
	});
});

describe("Unreachable code — no semicolon required", () => {
	it("detects unreachable code after return without semicolon", async () => {
		const file = join(TEST_DIR, "src/return-no-semi.ts");
		writeFileSync(
			file,
			`function foo() {
  return value
  doSomething()
}
`,
		);
		const fixes = await detect(file);
		const unreachable = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Unreachable"));
		expect(unreachable.length).toBe(1);
	});

	it("detects unreachable code after throw without semicolon", async () => {
		const file = join(TEST_DIR, "src/throw-no-semi.ts");
		writeFileSync(
			file,
			`function foo() {
  throw new Error("fail")
  cleanup()
}
`,
		);
		const fixes = await detect(file);
		const unreachable = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Unreachable"));
		expect(unreachable.length).toBe(1);
	});

	it("does NOT detect unreachable on multiline return object", async () => {
		const file = join(TEST_DIR, "src/multiline-return.ts");
		writeFileSync(
			file,
			`function foo() {
  return {
    a: 1,
    b: 2,
  }
}
`,
		);
		const fixes = await detect(file);
		const unreachable = fixes.flatMap((f) => f.errors).filter((e) => e.includes("Unreachable"));
		expect(unreachable.length).toBe(0);
	});
});
