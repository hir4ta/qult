import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { isGateDisabled } from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";
import { sanitizeForStderr } from "../sanitize.ts";

const CHECKABLE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".mjs",
	".cjs",
	".py",
	".pyi",
	".go",
	".rs",
	".rb",
	".java",
	".kt",
	".php",
	".cs",
]);

const MAX_CHECK_SIZE = 500_000;

// ── Secret patterns ──────────────────────────────────────────
// Each: [regex, description]. Anchored to line content (not multiline).
// Designed for high-precision: minimize false positives over false negatives.

interface SecretPattern {
	re: RegExp;
	desc: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
	// Specific token formats first (before generic patterns)
	// AWS
	{ re: /(?:AKIA|ASIA)[A-Z0-9]{16,}/, desc: "AWS access key" },
	// GitHub tokens
	{ re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/, desc: "GitHub token" },
	// Slack tokens
	{ re: /xox[bpas]-[A-Za-z0-9-]{10,}/, desc: "Slack token" },
	// Stripe keys
	{ re: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{20,}/, desc: "Stripe key" },
	// Generic bearer token in code
	{
		re: /["'`]Bearer\s+[A-Za-z0-9_\-/.+=]{20,}["'`]/,
		desc: "Hardcoded Bearer token",
	},
	// Generic patterns last (catch-all)
	// Generic API key assignments (high-entropy strings)
	{
		re: /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*["'`][A-Za-z0-9_\-/.]{20,}["'`]/i,
		desc: "Hardcoded API key",
	},
	// Generic secret/password assignments
	{
		re: /(?:secret|password|passwd|pwd|token|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[:=]\s*["'`][^\s"'`]{8,}["'`]/i,
		desc: "Hardcoded secret/password",
	},
	// Private key markers
	{ re: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, desc: "Private key" },
	// Connection strings with credentials
	{
		re: /(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^:]+:[^@\s]{4,}@/i,
		desc: "Connection string with embedded credentials",
	},
];

// ── Dangerous code patterns ──────────────────────────────────

interface DangerousPattern {
	re: RegExp;
	desc: string;
	/** File extensions this pattern applies to (empty = all checkable) */
	exts?: Set<string>;
}

const JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const PY_EXTS = new Set([".py", ".pyi"]);
const GO_EXTS = new Set([".go"]);
const RB_EXTS = new Set([".rb"]);
const JAVA_EXTS = new Set([".java", ".kt"]);

const DANGEROUS_PATTERNS: DangerousPattern[] = [
	// eval() with variables (not static string)
	{
		re: /\beval\s*\(\s*(?!["'`])[a-zA-Z_$]/,
		desc: "eval() with dynamic input — command injection risk",
		exts: JS_TS_EXTS,
	},
	// innerHTML assignment with variable
	{
		re: /\.innerHTML\s*=\s*(?!["'`]|`\s*$)[a-zA-Z_$]/,
		desc: "innerHTML assignment with dynamic value — XSS risk",
		exts: JS_TS_EXTS,
	},
	// document.write with variable
	{
		re: /document\.write\s*\(\s*(?!["'`])[a-zA-Z_$]/,
		desc: "document.write() with dynamic input — XSS risk",
		exts: JS_TS_EXTS,
	},
	// child_process exec/execSync with template literal or variable
	{
		re: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|[a-zA-Z_$](?!['"]))/,
		desc: "exec/execSync with dynamic command — command injection risk",
		exts: JS_TS_EXTS,
	},
	// SQL string concatenation
	{
		re: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*["'`]\s*\+\s*[a-zA-Z_$]/i,
		desc: "SQL string concatenation — SQL injection risk",
	},
	// SQL template literal with ${} (not parameterized)
	{
		re: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*\$\{/i,
		desc: "SQL template literal with interpolation — SQL injection risk",
	},
	// Python os.system / subprocess with f-string / format
	{
		re: /(?:os\.system|subprocess\.(?:call|run|Popen|check_output))\s*\(\s*f["']/,
		desc: "Shell command with f-string — command injection risk",
		exts: PY_EXTS,
	},
	// Python eval/exec with variable
	{
		re: /\b(?:eval|exec)\s*\(\s*(?!["'])[a-zA-Z_]/,
		desc: "eval/exec with dynamic input — code injection risk",
		exts: PY_EXTS,
	},
	// dangerouslySetInnerHTML with variable
	{
		re: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!["'`])[a-zA-Z_$]/,
		desc: "dangerouslySetInnerHTML with dynamic value — XSS risk",
		exts: JS_TS_EXTS,
	},
	// OWASP A07: Password comparison without constant-time (timing attack)
	{
		re: /password\s*(?:===|!==|==|!=)\s*(?!null\b|undefined\b|["'`])[a-zA-Z_$]/i,
		desc: "Password compared with === instead of constant-time comparison — timing attack risk",
		exts: JS_TS_EXTS,
	},
	// OWASP A07: Session token in URL query parameter
	{
		re: /[?&](?:token|sessionId|session_id|auth_token|access_token)=/i,
		desc: "Session/auth token in URL query parameter — token leakage via referrer/logs",
	},
	// OWASP A08: Deserialization of untrusted JSON from user input
	{
		re: /JSON\.parse\s*\(\s*(?:req(?:uest)?\.body|req\.query|req\.params|ctx\.request\.body)/,
		desc: "JSON.parse on raw user input without validation — insecure deserialization risk",
		exts: JS_TS_EXTS,
	},
	// OWASP A08: Python pickle/yaml unsafe deserialization
	{
		re: /(?:pickle\.loads?|yaml\.(?:load|unsafe_load))\s*\(/,
		desc: "Unsafe deserialization (pickle/yaml.load) — arbitrary code execution risk",
		exts: PY_EXTS,
	},
	// Environment variable leakage in responses
	{
		re: /(?:res\.(?:json|send|write)|response\.(?:json|send|write))\s*\(.*process\.env/,
		desc: "process.env leaked in HTTP response — environment variable disclosure",
		exts: JS_TS_EXTS,
	},
	// OWASP A01: Path traversal — file operations with user input
	{
		re: /(?:readFile|writeFile|createReadStream|createWriteStream|readdir|unlink|rmSync)\s*\(.*(?:req\.|params\.|query\.|ctx\.(?:request|params|query))/,
		desc: "File operation with user-controlled path — path traversal risk",
		exts: JS_TS_EXTS,
	},
	// OWASP A10: SSRF — HTTP requests with user-controlled URLs
	{
		re: /(?:fetch|axios\.(?:get|post|put|delete|patch|request)|http\.(?:get|request)|got|urllib\.request\.urlopen)\s*\(.*(?:req\.|params\.|query\.|ctx\.(?:request|params|query))/,
		desc: "HTTP request with user-controlled URL — SSRF risk",
		exts: JS_TS_EXTS,
	},
	// OWASP A10: SSRF — Python requests with user input
	{
		re: /requests\.(?:get|post|put|delete|patch|head)\s*\(\s*(?!["'])[a-zA-Z_]/,
		desc: "HTTP request with dynamic URL — SSRF risk",
		exts: PY_EXTS,
	},
	// Prototype pollution — __proto__ or constructor.prototype assignment
	{
		re: /(?:__proto__|constructor\s*\.\s*prototype)\s*(?:\[|\.\s*\w+\s*=)/,
		desc: "Prototype pollution — __proto__/constructor.prototype mutation",
		exts: JS_TS_EXTS,
	},
	// Dynamic require/import with variable (supply-chain risk)
	{
		re: /\brequire\s*\(\s*(?!["'`])[a-zA-Z_$]/,
		desc: "Dynamic require() with variable — supply-chain/injection risk",
		exts: JS_TS_EXTS,
	},
	// Go exec.Command with string concatenation
	{
		re: /exec\.Command\s*\(.*\+/,
		desc: "exec.Command with string concatenation — command injection risk",
		exts: GO_EXTS,
	},
	// Ruby system() with variable
	{
		re: /\bsystem\s*\(\s*(?!["'])[a-zA-Z_]/,
		desc: "system() with dynamic input — command injection risk",
		exts: RB_EXTS,
	},
	// Ruby send() with user input
	{
		re: /\.send\s*\(\s*(?:params|request|args)/,
		desc: "send() with user input — arbitrary method call risk",
		exts: RB_EXTS,
	},
	// Java Runtime.exec() with variable
	{
		re: /Runtime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(\s*(?!["'])[a-zA-Z_]/,
		desc: "Runtime.exec() with dynamic input — command injection risk",
		exts: JAVA_EXTS,
	},
	// Weak crypto MD5
	{
		re: /\b(?:createHash|MessageDigest\.getInstance)\s*\(\s*["'](?:md5|MD5)["']/,
		desc: "MD5 usage — cryptographically weak, use SHA-256+",
	},
	// Weak crypto SHA1 for passwords
	{
		re: /(?:sha1|SHA1).*(?:password|passwd|pwd)/i,
		desc: "SHA1 for password hashing — use bcrypt/scrypt/argon2",
	},
	// Hardcoded IV/nonce
	{
		re: /(?:iv|nonce|IV|NONCE)\s*[:=]\s*["'`][a-fA-F0-9]{16,}["'`]/,
		desc: "Hardcoded IV/nonce — use random generation",
	},
];

/** Detect hardcoded secrets and dangerous code patterns.
 *  Returns PendingFix[] (computational on_write sensor, no external tools needed). */
export function detectSecurityPatterns(file: string): PendingFix[] {
	if (isGateDisabled("security-check")) return [];
	const ext = extname(file).toLowerCase();
	if (!CHECKABLE_EXTS.has(ext)) return [];
	if (!existsSync(file)) return [];

	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	if (content.length > MAX_CHECK_SIZE) return [];

	const errors: string[] = [];
	const lines = content.split("\n");

	// Determine test file status once (not per-line)
	const fileName = file.split("/").pop() ?? "";
	const isTestFile =
		fileName.includes(".test.") ||
		fileName.includes(".spec.") ||
		fileName.startsWith("test_") ||
		fileName.includes("_test.");

	// Languages where `*` at line start is a comment (JSDoc / block comment body)
	const starIsComment = JS_TS_EXTS.has(ext) || ext === ".java" || ext === ".kt" || ext === ".cs";
	// Languages that support /* ... */ block comments
	const hasBlockComments =
		JS_TS_EXTS.has(ext) ||
		ext === ".java" ||
		ext === ".kt" ||
		ext === ".cs" ||
		ext === ".go" ||
		ext === ".rs";
	let inBlockComment = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trimStart();

		// Track block comment state — strip comment portions from the line for scanning
		let scanLine = line; // the portion of the line to scan for patterns
		if (hasBlockComments) {
			if (inBlockComment) {
				const endIdx = line.indexOf("*/");
				if (endIdx >= 0) {
					inBlockComment = false;
					// Only scan content AFTER the closing comment marker
					scanLine = line.slice(endIdx + 2);
					if (!scanLine.trim()) continue; // nothing after comment
				} else {
					continue;
				}
			}
			if (!inBlockComment && trimmed.startsWith("/*")) {
				const endIdx = line.indexOf("*/", line.indexOf("/*") + 2);
				if (endIdx < 0) {
					inBlockComment = true;
					continue;
				}
				// Single-line /* ... */: only scan content after the comment
				scanLine = line.slice(endIdx + 2);
				if (!scanLine.trim()) continue; // entire line is comment
			}
		}

		// Skip comments (// for C-family, # for Python/Ruby, * for JSDoc-style block comments)
		const scanTrimmed = scanLine.trimStart();
		if (scanTrimmed.startsWith("//") || scanTrimmed.startsWith("#")) continue;
		if (starIsComment && scanTrimmed.startsWith("*")) continue;

		// Secret patterns (skip test files)
		if (!isTestFile) {
			for (const { re, desc } of SECRET_PATTERNS) {
				if (re.test(scanLine)) {
					// Exclude common false positives: env var references, config keys without values
					if (/process\.env\b/.test(scanLine)) continue;
					if (/os\.environ/.test(scanLine)) continue;
					if (/\$\{?\w*ENV\w*\}?/.test(scanLine)) continue;
					errors.push(`L${i + 1}: ${desc}`);
					break; // one secret finding per line (secrets are mutually exclusive patterns)
				}
			}
		}

		// Dangerous patterns (always check, including tests) — collect ALL matches per line
		for (const { re, desc, exts } of DANGEROUS_PATTERNS) {
			if (exts && !exts.has(ext)) continue;
			if (re.test(scanLine)) {
				errors.push(`L${i + 1}: ${desc}`);
			}
		}
	}

	// Advisory patterns (stderr only, not PendingFix)
	emitAdvisoryWarnings(file, content);

	if (errors.length === 0) return [];

	return [
		{
			file,
			errors: errors.map((e) => sanitizeForStderr(e.slice(0, 300))),
			gate: "security-check",
		},
	];
}

// ── Advisory patterns (stderr-only, informational for reviewers) ──

interface AdvisoryPattern {
	re: RegExp;
	/** Regex that, if present on the same line, suppresses the warning */
	suppress: RegExp;
	desc: string;
	/** File extensions this pattern applies to (empty = all checkable) */
	exts?: Set<string>;
}

const ADVISORY_PATTERNS: AdvisoryPattern[] = [
	{
		re: /\bapp\.(?:get|post|put|delete|patch)\s*\(\s*["'`]\/api\//,
		suppress: /(?:auth|middleware|protect|guard|verify|session)/i,
		desc: "API route — verify auth middleware is applied",
		exts: JS_TS_EXTS,
	},
	{
		re: /\bwss?\.on\s*\(\s*["'`]connection["'`]/,
		suppress: /(?:auth|token|verify|session|guard)/i,
		desc: "WebSocket handler — verify authentication is applied",
		exts: JS_TS_EXTS,
	},
	// OWASP A05: CORS wildcard
	{
		re: /Access-Control-Allow-Origin['":\s]*\*/,
		suppress: /(?:localhost|127\.0\.0\.1|development|test)/i,
		desc: "CORS wildcard origin (*) — restrict to specific origins in production",
	},
	// OWASP A05: cors() without options
	{
		re: /\bcors\s*\(\s*\)/,
		suppress: /(?:\/\/\s*(?:dev|test|local))/i,
		desc: "cors() with no options — allows all origins by default",
		exts: JS_TS_EXTS,
	},
	// OWASP A05: Debug mode hardcoded
	{
		re: /\bdebug\s*[:=]\s*true\b/,
		suppress: /(?:test|spec|mock|\.test\.|\.spec\.)/i,
		desc: "Hardcoded debug=true — verify this is not in production config",
	},
	// Source map exposure in config
	{
		re: /\bsourceMap\s*[:=]\s*true\b/,
		suppress: /(?:dev|development|test)/i,
		desc: "Source maps enabled — verify they are not shipped to production (VibeGuard)",
	},
	// OWASP A09: Sensitive data in logs
	{
		re: /(?:console\.(?:log|info|warn|debug)|logger\.(?:info|warn|debug|log))\s*\(.*(?:password|passwd|secret|token|apiKey|api_key|credential|private_key)/i,
		suppress: /(?:mask|redact|sanitize|\*{3,})/i,
		desc: "Potential sensitive data in log output — mask before logging",
		exts: JS_TS_EXTS,
	},
	// Unsafe dependency versions
	{
		re: /["']\s*(?:\*|latest)\s*["']\s*$/,
		suppress: /(?:peerDependencies|devDependencies|optionalDependencies)/i,
		desc: "Wildcard/latest dependency version — pin to specific version for supply-chain safety",
	},
	// Cookie missing httpOnly
	{
		re: /\.cookie\s*\(.*httpOnly\s*:\s*false/,
		suppress: /(?:test|spec|mock)/i,
		desc: "Cookie with httpOnly: false — session hijacking risk",
		exts: JS_TS_EXTS,
	},
];

function emitAdvisoryWarnings(file: string, content: string): void {
	try {
		const ext = extname(file).toLowerCase();
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			for (const { re, suppress, desc, exts } of ADVISORY_PATTERNS) {
				if (exts && !exts.has(ext)) continue;
				if (re.test(line) && !suppress.test(line)) {
					const relative = file.split("/").slice(-3).join("/");
					process.stderr.write(`[qult] Security advisory: ${relative}:${i + 1} — ${desc}\n`);
				}
			}
		}
	} catch {
		/* fail-open */
	}
}
