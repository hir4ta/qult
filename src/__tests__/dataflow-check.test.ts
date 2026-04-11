import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectDataflowIssues } from "../hooks/detectors/dataflow-check.ts";

const TMP_DIR = join(process.cwd(), ".tmp-dataflow-test");

beforeAll(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

function writeTmp(name: string, content: string): string {
	const p = join(TMP_DIR, name);
	writeFileSync(p, content);
	return p;
}

describe("detectDataflowIssues", () => {
	it("detects taint from req.body to eval", async () => {
		const file = writeTmp(
			"direct.ts",
			`
const x = req.body;
eval(x);
`,
		);
		const fixes = await detectDataflowIssues(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.gate).toBe("dataflow-check");
		expect(fixes[0]!.errors.some((e) => e.includes("eval"))).toBe(true);
	});

	it("detects function argument taint propagation", async () => {
		const file = writeTmp(
			"func-arg.ts",
			`
function dangerous(input) {
  eval(input);
}
dangerous(req.body);
`,
		);
		const fixes = await detectDataflowIssues(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors.length).toBeGreaterThan(0);
	});

	it("detects 3-hop taint propagation", async () => {
		const file = writeTmp(
			"multi-hop.ts",
			`
const a = req.query;
const b = a;
const c = b;
eval(c);
`,
		);
		const fixes = await detectDataflowIssues(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.gate).toBe("dataflow-check");
	});

	it("does not flag eval with static string", async () => {
		const file = writeTmp(
			"safe-eval.ts",
			`
eval("console.log('hello')");
`,
		);
		const fixes = await detectDataflowIssues(file);
		expect(fixes.length).toBe(0);
	});

	it("detects Python request.form to os.system", async () => {
		const file = writeTmp(
			"taint.py",
			`
x = request.form["name"]
os.system(x)
`,
		);
		const fixes = await detectDataflowIssues(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.gate).toBe("dataflow-check");
	});

	it("returns empty array for CSS files", async () => {
		const file = writeTmp("style.css", "body { color: red; }");
		const fixes = await detectDataflowIssues(file);
		expect(fixes).toEqual([]);
	});

	it("returns empty array for non-existent files", async () => {
		const fixes = await detectDataflowIssues("/nonexistent/path.ts");
		expect(fixes).toEqual([]);
	});
});
