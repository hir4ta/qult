/**
 * Security pattern detection — regex-based, language-aware.
 * Runs within PostToolUse 5s budget (<100ms for single file).
 */

export interface SecurityRule {
	id: string;
	pattern: RegExp;
	message: string;
	severity: "critical" | "high" | "medium";
	filePattern?: RegExp; // undefined = all files
}

export interface SecurityViolation {
	rule: string;
	line: number;
	detail: string;
	severity: "critical" | "high" | "medium";
}

const TEST_FILE_RE = /[./](test|spec|__tests__|__test__)[./]/i;
const IGNORE_RE = /security-ignore/;

// ===== Rules =====

const UNIVERSAL_RULES: SecurityRule[] = [
	{
		id: "hardcoded-aws-key",
		pattern: /AKIA[0-9A-Z]{16}/,
		message: "Hardcoded AWS access key detected",
		severity: "critical",
	},
	{
		id: "hardcoded-private-key",
		pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----/,
		message: "Embedded private key detected",
		severity: "critical",
	},
	{
		id: "hardcoded-api-key",
		pattern:
			/(?:sk_live_|sk_test_|ghp_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20}|AIza[0-9A-Za-z_-]{35})/,
		message: "Hardcoded API key/token detected",
		severity: "critical",
	},
	{
		id: "hardcoded-secret",
		pattern: /(?:password|secret|api_key|apikey|auth_token)\s*[:=]\s*["'][^"']{8,}["']/i,
		message: "Hardcoded secret/password in string literal",
		severity: "high",
	},
	{
		id: "eval-injection",
		pattern: /\beval\s*\(/,
		message: "eval() can execute arbitrary code — use safer alternatives",
		severity: "high",
	},
	{
		id: "innerhtml-xss",
		pattern: /\.innerHTML\s*=/,
		message: "innerHTML assignment is an XSS vector — use textContent or DOM APIs",
		severity: "high",
	},
	{
		id: "document-write",
		pattern: /document\.write\s*\(/,
		message: "document.write() is an XSS vector",
		severity: "high",
	},
];

const TS_JS_RULES: SecurityRule[] = [
	{
		id: "dangerously-set-inner-html",
		pattern: /dangerouslySetInnerHTML/,
		message: "dangerouslySetInnerHTML is an XSS vector in React",
		severity: "high",
		filePattern: /\.[jt]sx?$/,
	},
	{
		id: "new-function",
		pattern: /new\s+Function\s*\(/,
		message: "new Function() is equivalent to eval() — avoid dynamic code execution",
		severity: "high",
		filePattern: /\.[jt]sx?$/,
	},
	{
		id: "shell-true",
		pattern: /shell\s*:\s*true/,
		message: "shell: true in child_process enables command injection",
		severity: "high",
		filePattern: /\.[jt]sx?$/,
	},
	{
		id: "exec-sync",
		pattern: /(?:execSync|exec)\s*\(\s*(?:[`'"].*\$\{|[^'"`]*\+)/,
		message: "String interpolation/concatenation in exec — potential command injection",
		severity: "high",
		filePattern: /\.[jt]sx?$/,
	},
	{
		id: "prototype-pollution",
		pattern: /__proto__|constructor\s*\[/,
		message: "Prototype pollution risk — avoid __proto__ and dynamic constructor access",
		severity: "high",
		filePattern: /\.[jt]sx?$/,
	},
];

const PYTHON_RULES: SecurityRule[] = [
	{
		id: "pickle-loads",
		pattern: /pickle\.(?:loads?|Unpickler)\s*\(/,
		message: "pickle deserialization can execute arbitrary code — use json or msgpack",
		severity: "high",
		filePattern: /\.py$/,
	},
	{
		id: "yaml-unsafe-load",
		pattern: /yaml\.(?!safe_)load\s*\(/,
		message: "yaml.load() is unsafe — use yaml.safe_load()",
		severity: "high",
		filePattern: /\.py$/,
	},
	{
		id: "subprocess-shell",
		pattern: /subprocess\.\w+\(.*shell\s*=\s*True/,
		message: "subprocess with shell=True enables command injection",
		severity: "high",
		filePattern: /\.py$/,
	},
	{
		id: "os-system",
		pattern: /os\.(?:system|popen)\s*\(/,
		message: "os.system/popen is vulnerable to injection — use subprocess with shell=False",
		severity: "high",
		filePattern: /\.py$/,
	},
];

const SQL_RULES: SecurityRule[] = [
	{
		id: "sql-string-concat",
		pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.*["'`]\s*\+/i,
		message: "SQL string concatenation — use parameterized queries",
		severity: "high",
	},
	{
		id: "sql-template-literal",
		pattern: /(?:query|execute|exec)\s*\(\s*`[^`]*\$\{/i,
		message: "SQL in template literal with interpolation — use parameterized queries",
		severity: "high",
	},
];

const ALL_RULES = [...UNIVERSAL_RULES, ...TS_JS_RULES, ...PYTHON_RULES, ...SQL_RULES];

export function getSecurityRules(): SecurityRule[] {
	return ALL_RULES;
}

export function checkSecurity(
	filePath: string,
	fileContent: string,
	rules?: SecurityRule[],
): SecurityViolation[] {
	// Skip test files
	if (TEST_FILE_RE.test(filePath)) return [];

	const activeRules = rules ?? ALL_RULES;
	const violations: SecurityViolation[] = [];
	const lines = fileContent.split("\n");

	for (let i = 0; i < lines.length && violations.length < 10; i++) {
		const line = lines[i]!;

		// Skip lines with security-ignore comment
		if (IGNORE_RE.test(line)) continue;

		for (const rule of activeRules) {
			if (violations.length >= 10) break;

			// Check file pattern
			if (rule.filePattern && !rule.filePattern.test(filePath)) continue;

			if (rule.pattern.test(line)) {
				violations.push({
					rule: rule.id,
					line: i + 1,
					detail: rule.message,
					severity: rule.severity,
				});
				break; // one violation per line
			}
		}
	}

	return violations;
}
