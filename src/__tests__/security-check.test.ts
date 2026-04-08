import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-security-check-test");
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

describe("detectSecurityPatterns", () => {
	async function detect(file: string) {
		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		return detectSecurityPatterns(file);
	}

	describe("secret detection", () => {
		it("detects AWS access keys", async () => {
			const file = join(TEST_DIR, "config.ts");
			writeFileSync(file, `const key = "AKIAIOSFODNN7EXAMPLE1";\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("AWS access key");
		});

		it("detects hardcoded API keys", async () => {
			const file = join(TEST_DIR, "api.ts");
			writeFileSync(file, `const api_key = "sk-abcdefghijklmnopqrstuvwxyz1234";\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("Hardcoded API key");
		});

		it("detects GitHub tokens", async () => {
			const file = join(TEST_DIR, "auth.ts");
			writeFileSync(file, `const token = "ghp_ABCDEFghijklmnopqrstuvwxyz0123456789";\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("GitHub token");
		});

		it("detects Stripe keys", async () => {
			const file = join(TEST_DIR, "billing.ts");
			writeFileSync(file, `const stripe = "sk_test_abcdefghijklmnopqrstuvwxyz";\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("Stripe key");
		});

		it("detects private key markers", async () => {
			const file = join(TEST_DIR, "cert.ts");
			writeFileSync(file, `const key = "-----BEGIN RSA PRIVATE KEY-----";\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("Private key");
		});

		it("detects connection strings with credentials", async () => {
			const file = join(TEST_DIR, "db.ts");
			writeFileSync(file, `const url = "postgres://admin:s3cret@localhost/db";\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("Connection string");
		});

		it("skips process.env references (false positive)", async () => {
			const file = join(TEST_DIR, "config.ts");
			writeFileSync(file, `const api_key = process.env.API_KEY;\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(0);
		});

		it("skips secrets in test files", async () => {
			const file = join(TEST_DIR, "auth.test.ts");
			writeFileSync(file, `const token = "ghp_ABCDEFghijklmnopqrstuvwxyz0123456789";\n`);
			const fixes = await detect(file);
			// Test files skip secret detection (test fixtures often have fake keys)
			expect(fixes.length).toBe(0);
		});

		it("skips comments", async () => {
			const file = join(TEST_DIR, "config.ts");
			writeFileSync(file, `// const key = "AKIAIOSFODNN7EXAMPLE1";\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(0);
		});
	});

	describe("dangerous pattern detection", () => {
		it("detects eval with dynamic input", async () => {
			const file = join(TEST_DIR, "handler.ts");
			writeFileSync(file, `function run(code: string) {\n  return eval(code);\n}\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("eval()");
			expect(fixes[0]!.errors[0]).toContain("command injection");
		});

		it("detects innerHTML with dynamic value", async () => {
			const file = join(TEST_DIR, "render.ts");
			writeFileSync(file, `element.innerHTML = userInput;\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("innerHTML");
			expect(fixes[0]!.errors[0]).toContain("XSS");
		});

		it("detects exec with template literal", async () => {
			const file = join(TEST_DIR, "cmd.ts");
			writeFileSync(file, "const result = execSync(`ls ${userDir}`);\n");
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("exec");
		});

		it("detects SQL string concatenation", async () => {
			const file = join(TEST_DIR, "query.ts");
			writeFileSync(file, `const sql = "SELECT * FROM users WHERE id = " + userId;\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("SQL");
		});

		it("detects Python eval with dynamic input", async () => {
			const file = join(TEST_DIR, "handler.py");
			writeFileSync(file, `result = eval(user_input)\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("eval/exec");
		});

		it("detects Python os.system with f-string", async () => {
			const file = join(TEST_DIR, "cmd.py");
			writeFileSync(file, `os.system(f"rm {user_path}")\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("f-string");
		});

		it("allows eval with static string", async () => {
			const file = join(TEST_DIR, "safe.ts");
			writeFileSync(file, `const x = eval("1 + 2");\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(0);
		});

		it("detects password comparison without constant-time", async () => {
			const file = join(TEST_DIR, "auth.ts");
			writeFileSync(file, "if (password === storedPassword) { login(); }\n");
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("timing attack");
		});

		it("allows password null check", async () => {
			const file = join(TEST_DIR, "auth-null.ts");
			writeFileSync(file, "if (password === null) { throw new Error(); }\n");
			const fixes = await detect(file);
			expect(fixes.length).toBe(0);
		});

		it("detects session token in URL", async () => {
			const file = join(TEST_DIR, "redirect.ts");
			writeFileSync(file, 'const url = "/api/data?token=abc123";\n');
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("token leakage");
		});

		it("detects JSON.parse on req.body", async () => {
			const file = join(TEST_DIR, "handler.ts");
			writeFileSync(file, "const data = JSON.parse(req.body);\n");
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("deserialization");
		});

		it("detects Python pickle.loads", async () => {
			const file = join(TEST_DIR, "handler.py");
			writeFileSync(file, "data = pickle.loads(user_input)\n");
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("pickle");
		});

		it("detects process.env in HTTP response", async () => {
			const file = join(TEST_DIR, "debug.ts");
			writeFileSync(file, "res.json({ env: process.env });\n");
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("process.env");
		});

		it("detects dangerous patterns in test files too", async () => {
			const file = join(TEST_DIR, "handler.test.ts");
			writeFileSync(file, `function run(code: string) {\n  return eval(code);\n}\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("eval()");
		});
	});

	it("returns empty for non-checkable extensions", async () => {
		const file = join(TEST_DIR, "data.json");
		writeFileSync(file, `{"api_key": "sk-abcdefghijklmnopqrstuvwxyz1234"}\n`);
		const fixes = await detect(file);
		expect(fixes.length).toBe(0);
	});

	it("returns empty for missing files", async () => {
		const fixes = await detect(join(TEST_DIR, "nonexistent.ts"));
		expect(fixes.length).toBe(0);
	});

	it("gate attribute is security-check", async () => {
		const file = join(TEST_DIR, "bad.ts");
		writeFileSync(file, `const token = "ghp_ABCDEFghijklmnopqrstuvwxyz0123456789";\n`);
		const fixes = await detect(file);
		expect(fixes[0]!.gate).toBe("security-check");
	});

	describe("block comment skipping", () => {
		it("skips secret inside /* ... */ block comment", async () => {
			const file = join(TEST_DIR, "block-comment.ts");
			writeFileSync(
				file,
				`/*
 * const key = "AKIAIOSFODNN7EXAMPLE1";
 */
const x = 1;
`,
			);
			const fixes = await detect(file);
			expect(fixes.length).toBe(0);
		});

		it("skips dangerous pattern inside /* ... */ block comment", async () => {
			const file = join(TEST_DIR, "block-comment-eval.ts");
			writeFileSync(
				file,
				`/* example: eval(userInput) is dangerous */
function safe() {
  return 42;
}
`,
			);
			const fixes = await detect(file);
			expect(fixes.length).toBe(0);
		});

		it("detects pattern on line after block comment ends", async () => {
			const file = join(TEST_DIR, "after-block.ts");
			writeFileSync(
				file,
				`/* start
   end */
const key = "AKIAIOSFODNN7EXAMPLE1";
`,
			);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("AWS access key");
		});
	});
});

describe("emitAdvisoryWarnings", () => {
	let stderrCapture: string[] = [];

	beforeEach(() => {
		stderrCapture = [];
		vi.spyOn(process.stderr, "write").mockImplementation((data) => {
			stderrCapture.push(typeof data === "string" ? data : data.toString());
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function detectWithAdvisory(file: string) {
		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		detectSecurityPatterns(file);
		return stderrCapture;
	}

	it("emits advisory warning for unprotected route", async () => {
		const file = join(TEST_DIR, "routes.ts");
		writeFileSync(file, `app.get("/api/data", handler);\n`);
		const warnings = await detectWithAdvisory(file);
		expect(warnings.some((w) => w.includes("API route"))).toBe(true);
	});

	it("does not warn when auth middleware is present", async () => {
		const file = join(TEST_DIR, "routes.ts");
		writeFileSync(file, `app.get("/api/data", authMiddleware, handler);\n`);
		const warnings = await detectWithAdvisory(file);
		expect(warnings.some((w) => w.includes("API route"))).toBe(false);
	});

	it("emits advisory warning for WebSocket without auth", async () => {
		const file = join(TEST_DIR, "ws.ts");
		writeFileSync(file, `wss.on("connection", (socket) => { socket.send("hi"); });\n`);
		const warnings = await detectWithAdvisory(file);
		expect(warnings.some((w) => w.includes("WebSocket"))).toBe(true);
	});

	it("does not emit advisory for non-JS files", async () => {
		const file = join(TEST_DIR, "notes.md");
		writeFileSync(file, `app.get("/api/data", handler);\n`);
		const warnings = await detectWithAdvisory(file);
		expect(warnings.some((w) => w.includes("API route"))).toBe(false);
	});
});
