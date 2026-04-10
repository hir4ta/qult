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
			writeFileSync(file, "const result = execSync(`ls $" + "{userDir}`);\n");
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

		it("detects Go exec.Command with string concatenation", async () => {
			const file = join(TEST_DIR, "cmd.go");
			writeFileSync(file, `cmd := exec.Command("sh", "-c", base + userInput)\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("exec.Command");
			expect(fixes[0]!.errors[0]).toContain("command injection");
		});

		it("detects Ruby system() with dynamic input", async () => {
			const file = join(TEST_DIR, "cmd.rb");
			writeFileSync(file, `system(user_input)\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("system()");
			expect(fixes[0]!.errors[0]).toContain("command injection");
		});

		it("detects Ruby send() with user input", async () => {
			const file = join(TEST_DIR, "dispatch.rb");
			writeFileSync(file, `obj.send(params[:method], args)\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("send()");
			expect(fixes[0]!.errors[0]).toContain("arbitrary method call");
		});

		it("detects Java Runtime.exec() with dynamic input", async () => {
			const file = join(TEST_DIR, "Exec.java");
			writeFileSync(file, `Runtime.getRuntime().exec(userCommand);\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("Runtime.exec()");
			expect(fixes[0]!.errors[0]).toContain("command injection");
		});

		it("detects MD5 usage as weak crypto", async () => {
			const file = join(TEST_DIR, "hash.ts");
			writeFileSync(file, `const hash = createHash("md5").update(data).digest("hex");\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("MD5");
			expect(fixes[0]!.errors[0]).toContain("cryptographically weak");
		});

		it("detects SHA1 for password hashing", async () => {
			const file = join(TEST_DIR, "auth.ts");
			writeFileSync(file, `const hashed = sha1(password);\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("SHA1");
			expect(fixes[0]!.errors[0]).toContain("bcrypt");
		});

		it("detects hardcoded IV/nonce", async () => {
			const file = join(TEST_DIR, "crypto.ts");
			writeFileSync(file, `const iv = "0123456789abcdef0123456789abcdef";\n`);
			const fixes = await detect(file);
			expect(fixes.length).toBe(1);
			expect(fixes[0]!.errors[0]).toContain("Hardcoded IV/nonce");
			expect(fixes[0]!.errors[0]).toContain("random generation");
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

	it("emits advisory warning for cookie with httpOnly: false", async () => {
		const file = join(TEST_DIR, "session.ts");
		writeFileSync(file, `res.cookie("sid", token, { httpOnly: false, secure: true });\n`);
		const warnings = await detectWithAdvisory(file);
		expect(warnings.some((w) => w.includes("httpOnly"))).toBe(true);
		expect(warnings.some((w) => w.includes("session hijacking"))).toBe(true);
	});

	it("suppresses cookie advisory when line contains test/spec/mock", async () => {
		const file = join(TEST_DIR, "session.ts");
		writeFileSync(file, `// test: res.cookie("sid", token, { httpOnly: false });\n`);
		const warnings = await detectWithAdvisory(file);
		expect(warnings.some((w) => w.includes("httpOnly"))).toBe(false);
	});

	it("does not emit advisory for non-JS files", async () => {
		const file = join(TEST_DIR, "notes.md");
		writeFileSync(file, `app.get("/api/data", handler);\n`);
		const warnings = await detectWithAdvisory(file);
		expect(warnings.some((w) => w.includes("API route"))).toBe(false);
	});
});

describe("promoted advisory → blocking patterns", () => {
	it("detects CORS wildcard as blocking PendingFix", async () => {
		const file = join(TEST_DIR, "server.ts");
		writeFileSync(file, `"Access-Control-Allow-Origin": "*"\n`);
		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		const fixes = detectSecurityPatterns(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e) => e.includes("CORS wildcard"))).toBe(true);
	});

	it("suppresses CORS wildcard on localhost lines", async () => {
		const file = join(TEST_DIR, "dev.ts");
		writeFileSync(file, `"Access-Control-Allow-Origin": "*" // localhost\n`);
		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		const fixes = detectSecurityPatterns(file);
		const corsErrors = fixes.flatMap((f) => f.errors).filter((e) => e.includes("CORS wildcard"));
		expect(corsErrors).toHaveLength(0);
	});

	it("detects hardcoded debug mode as blocking PendingFix", async () => {
		const file = join(TEST_DIR, "config.ts");
		writeFileSync(file, `const config = { debug: true };\n`);
		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		const fixes = detectSecurityPatterns(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e) => e.includes("debug=true") || e.includes("debug"))).toBe(
			true,
		);
	});

	it("suppresses debug mode when line contains test/mock context", async () => {
		const file = join(TEST_DIR, "config.ts");
		writeFileSync(file, `const mockConfig = { debug: true }; // test config\n`);
		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		const fixes = detectSecurityPatterns(file);
		const debugErrors = fixes.flatMap((f) => f.errors).filter((e) => e.includes("debug"));
		expect(debugErrors).toHaveLength(0);
	});

	it("detects source map exposure as blocking PendingFix", async () => {
		const file = join(TEST_DIR, "build.ts");
		writeFileSync(file, `const config = { sourceMap: true };\n`);
		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		const fixes = detectSecurityPatterns(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e) => e.includes("Source map") || e.includes("source"))).toBe(
			true,
		);
	});

	it("suppresses source map when line contains dev context", async () => {
		const file = join(TEST_DIR, "webpack.config.ts");
		writeFileSync(file, `const config = { sourceMap: true }; // development only\n`);
		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		const fixes = detectSecurityPatterns(file);
		const srcMapErrors = fixes
			.flatMap((f) => f.errors)
			.filter((e) => e.includes("Source map") || e.includes("source"));
		expect(srcMapErrors).toHaveLength(0);
	});
});

describe("getAdvisoryAsPendingFixes", () => {
	it("returns PendingFix for advisory patterns when called with content", async () => {
		const file = join(TEST_DIR, "routes.ts");
		const content = `app.get("/api/users", handler);\n`;
		writeFileSync(file, content);
		const { getAdvisoryAsPendingFixes } = await import("../hooks/detectors/security-check.ts");
		const fixes = getAdvisoryAsPendingFixes(file, content);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.gate).toBe("security-check-advisory");
		expect(fixes[0]!.errors.some((e: string) => e.includes("API route"))).toBe(true);
	});

	it("returns empty array for files with no advisory matches", async () => {
		const file = join(TEST_DIR, "clean.ts");
		const content = `const x = 1;\n`;
		writeFileSync(file, content);
		const { getAdvisoryAsPendingFixes } = await import("../hooks/detectors/security-check.ts");
		const fixes = getAdvisoryAsPendingFixes(file, content);
		expect(fixes).toHaveLength(0);
	});
});

describe("extended secret patterns", () => {
	async function detect(file: string) {
		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		return detectSecurityPatterns(file);
	}

	it("detects Google API key", async () => {
		const file = join(TEST_DIR, "config.ts");
		writeFileSync(file, `const key = "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q";\n`);
		const fixes = await detect(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e: string) => e.includes("Google API key"))).toBe(true);
	});

	it("detects SendGrid API key", async () => {
		const file = join(TEST_DIR, "config.ts");
		writeFileSync(file, `const key = "SG.abcdefghijklmnop.qrstuvwxyz123456";\n`);
		const fixes = await detect(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e: string) => e.includes("SendGrid"))).toBe(true);
	});

	it("detects npm token", async () => {
		const file = join(TEST_DIR, "config.ts");
		writeFileSync(file, `const token = "npm_1234567890abcdefghijklmnopqrstuv";\n`);
		const fixes = await detect(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e: string) => e.includes("npm token"))).toBe(true);
	});

	it("detects PyPI token", async () => {
		const file = join(TEST_DIR, "config.ts");
		writeFileSync(
			file,
			`const token = "pypi-AgEIcHlwaS5vcmcCJGI5ZmQ0ODJkLWQ3MDEtNDcxMjM0NTY3ODkw2OSI";\n`,
		);
		const fixes = await detect(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e: string) => e.includes("PyPI token"))).toBe(true);
	});

	it("detects DigitalOcean token", async () => {
		const file = join(TEST_DIR, "config.ts");
		// Build token dynamically to avoid GitHub push protection on test fixtures
		const doToken = ["dop", "v1", "a".repeat(64)].join("_");
		writeFileSync(file, `const token = "${doToken}";\n`);
		const fixes = await detect(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e: string) => e.includes("DigitalOcean"))).toBe(true);
	});

	it("detects Twilio API key", async () => {
		const file = join(TEST_DIR, "config.ts");
		// Build token dynamically to avoid GitHub push protection on test fixtures
		const twilioKey = `SK${"ab12cd34".repeat(4)}`;
		writeFileSync(file, `const key = "${twilioKey}";\n`);
		const fixes = await detect(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e: string) => e.includes("Twilio"))).toBe(true);
	});

	it("detects Azure JWT token", async () => {
		const file = join(TEST_DIR, "config.ts");
		writeFileSync(
			file,
			`const token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImtpZCI6Ik1mRjJ0QW1BeDhKcm1VMDBVN1NjQ3VWZ0tpRjRwNlZFZ3paWThURXBoX0EifQ.rest";
`,
		);
		const fixes = await detect(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e: string) => e.includes("Hardcoded JWT"))).toBe(true);
	});

	it("detects Heroku API key in assignment", async () => {
		const file = join(TEST_DIR, "config.ts");
		writeFileSync(
			file,
			`const heroku_api_key = "12345678-1234-1234-1234-1234567890ab";
`,
		);
		const fixes = await detect(file);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.errors.some((e: string) => e.includes("Heroku API key"))).toBe(true);
	});

	it("does not flag env var references", async () => {
		const file = join(TEST_DIR, "config.ts");
		writeFileSync(file, `const key = process.env.SENDGRID_API_KEY;\n`);
		const fixes = await detect(file);
		expect(fixes).toHaveLength(0);
	});

	it("skips test files", async () => {
		const file = join(TEST_DIR, "config.test.ts");
		writeFileSync(file, `const key = "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q";\n`);
		const fixes = await detect(file);
		// Test files skip secret detection
		const googleKeyFixes = fixes.filter(
			(f: { gate: string; errors: string[] }) =>
				f.gate === "security-check" && f.errors.some((e) => e.includes("Google API key")),
		);
		expect(googleKeyFixes).toHaveLength(0);
	});
});
