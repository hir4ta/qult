import { describe, expect, it } from "vitest";
import { checkSecurity, getSecurityRules } from "../security-check.js";

describe("security-check", () => {
	it("returns rules list", () => {
		const rules = getSecurityRules();
		expect(rules.length).toBeGreaterThan(10);
	});

	it("detects eval()", () => {
		const v = checkSecurity("src/foo.ts", 'const x = eval("code");');
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("eval-injection");
		expect(v[0]!.severity).toBe("high");
		expect(v[0]!.line).toBe(1);
	});

	it("detects innerHTML assignment", () => {
		const v = checkSecurity("src/foo.ts", "el.innerHTML = userInput;");
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("innerhtml-xss");
	});

	it("detects hardcoded AWS key", () => {
		const v = checkSecurity("src/config.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";');
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("hardcoded-aws-key");
		expect(v[0]!.severity).toBe("critical");
	});

	it("detects hardcoded password", () => {
		const v = checkSecurity("src/db.ts", 'const password = "supersecretpassword123";');
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("hardcoded-secret");
	});

	it("detects dangerouslySetInnerHTML in tsx", () => {
		const v = checkSecurity("src/App.tsx", "<div dangerouslySetInnerHTML={{__html: data}} />");
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("dangerously-set-inner-html");
	});

	it("detects new Function()", () => {
		const v = checkSecurity("src/foo.ts", 'const fn = new Function("return 1");');
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("new-function");
	});

	it("detects shell: true", () => {
		const v = checkSecurity("src/exec.ts", "spawn('cmd', [], { shell: true })");
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("shell-true");
	});

	it("detects SQL string concatenation", () => {
		const v = checkSecurity("src/db.ts", 'db.query("SELECT * FROM users WHERE id = " + userId);');
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("sql-string-concat");
	});

	it("detects pickle.loads in Python", () => {
		const v = checkSecurity("src/main.py", "data = pickle.loads(raw_bytes)");
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("pickle-loads");
	});

	it("detects subprocess shell=True in Python", () => {
		const v = checkSecurity("src/run.py", "subprocess.call(cmd, shell=True)");
		expect(v.length).toBe(1);
		expect(v[0]!.rule).toBe("subprocess-shell");
	});

	it("skips test files", () => {
		const v = checkSecurity("src/foo.test.ts", 'const x = eval("code");');
		expect(v).toHaveLength(0);
	});

	it("skips __tests__ directory", () => {
		const v = checkSecurity("src/__tests__/foo.ts", 'const x = eval("code");');
		expect(v).toHaveLength(0);
	});

	it("respects security-ignore comment", () => {
		const v = checkSecurity("src/foo.ts", 'eval("safe"); // security-ignore');
		expect(v).toHaveLength(0);
	});

	it("caps at 10 violations", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `const x${i} = eval("${i}");`).join("\n");
		const v = checkSecurity("src/foo.ts", lines);
		expect(v).toHaveLength(10);
	});

	it("returns empty for clean code", () => {
		const v = checkSecurity("src/foo.ts", 'const x = 1;\nconst y = "hello";\nconsole.log(x + y);');
		expect(v).toHaveLength(0);
	});

	it("does not flag yaml.safe_load (false positive prevention)", () => {
		const v = checkSecurity("src/main.py", "data = yaml.safe_load(content)");
		expect(v).toHaveLength(0);
	});

	it("flags yaml.load but not yaml.safe_load", () => {
		const v = checkSecurity("src/main.py", "data = yaml.load(content)");
		expect(v).toHaveLength(1);
		expect(v[0]!.rule).toBe("yaml-unsafe-load");
	});

	it("does not apply TypeScript rules to Python files", () => {
		const v = checkSecurity("src/main.py", "dangerouslySetInnerHTML");
		expect(v).toHaveLength(0);
	});

	it("one violation per line", () => {
		// eval and innerHTML on same line — only first rule match
		const v = checkSecurity("src/foo.ts", "eval(el.innerHTML = x);");
		expect(v).toHaveLength(1);
	});
});
