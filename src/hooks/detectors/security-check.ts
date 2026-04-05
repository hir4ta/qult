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
		if (hasBlockComments) {
			if (inBlockComment) {
				const endIdx = line.indexOf("*/");
				if (endIdx >= 0) {
					inBlockComment = false;
					// Replace everything up to and including */ with spaces, scan the rest
					const afterComment = line.slice(endIdx + 2);
					if (!afterComment.trim()) continue; // nothing after comment
					// Fall through to scan afterComment portion via the patterns below
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
				// Single-line /* ... */: strip the comment portion, scan remainder
				const afterComment = line.slice(endIdx + 2);
				if (!afterComment.trim()) continue; // entire line is comment
				// Fall through with original line — patterns will match on code after */
			}
		}

		// Skip comments (// for C-family, # for Python/Ruby, * for JSDoc-style block comments)
		if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
		if (starIsComment && trimmed.startsWith("*")) continue;

		// Secret patterns (skip test files)
		if (!isTestFile) {
			for (const { re, desc } of SECRET_PATTERNS) {
				if (re.test(line)) {
					// Exclude common false positives: env var references, config keys without values
					if (/process\.env\b/.test(line)) continue;
					if (/os\.environ/.test(line)) continue;
					if (/\$\{?\w*ENV\w*\}?/.test(line)) continue;
					errors.push(`L${i + 1}: ${desc}`);
					break; // one finding per line
				}
			}
		}

		// Dangerous patterns (always check, including tests)
		for (const { re, desc, exts } of DANGEROUS_PATTERNS) {
			if (exts && !exts.has(ext)) continue;
			if (re.test(line)) {
				errors.push(`L${i + 1}: ${desc}`);
				break; // one finding per line
			}
		}
	}

	// Advisory patterns (stderr only, not PendingFix)
	if (JS_TS_EXTS.has(ext)) {
		emitAdvisoryWarnings(file, content);
	}

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
}

const ADVISORY_PATTERNS: AdvisoryPattern[] = [
	{
		re: /\bapp\.(?:get|post|put|delete|patch)\s*\(\s*["'`]\/api\//,
		suppress: /auth|middleware|protect|guard|verify|session/i,
		desc: "API route — verify auth middleware is applied",
	},
	{
		re: /\bwss?\.on\s*\(\s*["'`]connection["'`]/,
		suppress: /auth|token|verify|session|guard/i,
		desc: "WebSocket handler — verify authentication is applied",
	},
];

function emitAdvisoryWarnings(file: string, content: string): void {
	try {
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			for (const { re, suppress, desc } of ADVISORY_PATTERNS) {
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
