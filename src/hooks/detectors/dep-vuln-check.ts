import { execFileSync } from "node:child_process";
import { isGateDisabled } from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";

const SCAN_TIMEOUT = 8_000;

// Severity levels that produce blocking PendingFix (others are advisory-only)
const BLOCKING_SEVERITIES = new Set(["CRITICAL", "HIGH"]);

// ── Install command parsing ──────────────────────────────────

interface InstalledPackages {
	pm: string;
	packages: string[];
}

const PM_PATTERNS: { re: RegExp; pm: string }[] = [
	{ re: /\bnpm\s+(?:install|i|add)\b/, pm: "npm" },
	{ re: /\byarn\s+add\b/, pm: "yarn" },
	{ re: /\bpnpm\s+add\b/, pm: "pnpm" },
	{ re: /\bbun\s+add\b/, pm: "bun" },
	{ re: /\bpip\s+install\b/, pm: "pip" },
	{ re: /\bcargo\s+add\b/, pm: "cargo" },
	{ re: /\bgo\s+get\b/, pm: "go" },
	{ re: /\bgem\s+install\b/, pm: "gem" },
	{ re: /\bcomposer\s+require\b/, pm: "composer" },
];

/** Extract package manager and package names from an install command.
 *  Returns null if the command is not an install command or has no packages. */
export function extractInstalledPackages(command: string): InstalledPackages | null {
	// Truncate at shell metacharacters before matching to avoid cross-command confusion
	const sanitized = command.replace(/\s*(?:&&|\|\||[;|]).*$/, "");

	for (const { re, pm } of PM_PATTERNS) {
		if (!re.test(sanitized)) continue;

		// Get everything after the install keyword
		const match = sanitized.match(re);
		if (!match) continue;
		const afterCmd = sanitized.slice(match.index! + match[0].length).trim();

		// Flags that consume the next token as their argument (not a package name)
		const FLAGS_WITH_ARGS = new Set([
			"-r",
			"-e",
			"-c",
			"-f",
			"--requirement",
			"--editable",
			"--constraint",
			"--config",
			"--features",
			"--path",
			"--prefix",
			"--target",
			"--registry",
		]);

		// Extract package names (skip flags and their arguments)
		const tokens = afterCmd.split(/\s+/).filter((t) => t.length > 0);
		const packages: string[] = [];
		let skipNext = false;
		for (const token of tokens) {
			if (skipNext) {
				skipNext = false;
				continue;
			}
			if (token.startsWith("-")) {
				// Check if this flag consumes the next token
				if (FLAGS_WITH_ARGS.has(token)) {
					skipNext = true;
				}
				continue;
			}
			// Skip path-like tokens (., ./, /, ~, file paths)
			if (
				token === "." ||
				token.startsWith("./") ||
				token.startsWith("/") ||
				token.startsWith("~")
			) {
				continue;
			}
			// Handle version specifiers: django>=4.0 → django
			if (pm === "pip") {
				packages.push(token.replace(/[><=!~;].*/, ""));
			} else if (pm === "npm" || pm === "yarn" || pm === "pnpm" || pm === "bun") {
				// Strip trailing @version: @scope/name@1.0 → @scope/name, name@1.0 → name
				let cleaned = token;
				const lastAt = token.lastIndexOf("@");
				if (lastAt > 0) {
					cleaned = token.slice(0, lastAt);
				}
				packages.push(cleaned);
			} else {
				packages.push(token);
			}
		}

		if (packages.length === 0) return null;
		return { pm, packages };
	}
	return null;
}

// ── osv-scanner integration ──────────────────────────────────

interface OsvResult {
	results?: OsvSourceResult[];
}

interface OsvSourceResult {
	source?: { path?: string; type?: string };
	packages?: OsvPackage[];
}

interface OsvPackage {
	package?: { name?: string; version?: string; ecosystem?: string };
	vulnerabilities?: OsvVuln[];
}

interface OsvVuln {
	id?: string;
	summary?: string;
	severity?: { type?: string; score?: string }[];
	database_specific?: { severity?: string };
}

/** Determine severity from osv-scanner vulnerability entry.
 *  Prefers database_specific.severity, falls back to CVSS score. */
function getSeverity(vuln: OsvVuln): string {
	// database_specific.severity is most direct
	if (vuln.database_specific?.severity) {
		return vuln.database_specific.severity.toUpperCase();
	}
	// Fall back to CVSS vector string (V3 or V4)
	if (vuln.severity) {
		for (const s of vuln.severity) {
			if ((s.type === "CVSS_V3" || s.type === "CVSS_V4") && s.score) {
				const vec = s.score;
				const isNetwork = vec.includes("AV:N");
				const hasHighImpact = vec.includes("C:H") || vec.includes("I:H") || vec.includes("A:H");
				// Conservative: any high-impact network vector → HIGH (blocking)
				if (isNetwork && hasHighImpact) return "HIGH";
				if (hasHighImpact) return "HIGH";
				return "MODERATE";
			}
		}
	}
	return "UNKNOWN";
}

/** Run osv-scanner with given args. Handles exit code 1 (vuln found → stdout has results).
 *  Returns stdout string on success, null on error (not installed, timeout, etc.).
 *  Shared by scanDependencyVulns, generate_sbom, and get_dependency_summary. */
export function runOsvScanner(args: string[], cwd: string, timeout: number): string | null {
	try {
		const output = execFileSync("osv-scanner", args, {
			cwd,
			timeout,
			stdio: ["pipe", "pipe", "pipe"],
			encoding: "utf-8",
		});
		return typeof output === "string" ? output : String(output);
	} catch (err: unknown) {
		// osv-scanner exits with code 1 when vulnerabilities are found — parse stdout
		if (
			err &&
			typeof err === "object" &&
			"stdout" in err &&
			typeof (err as { stdout: unknown }).stdout === "string" &&
			(err as { stdout: string }).stdout.length > 0
		) {
			return (err as { stdout: string }).stdout;
		}
		return null;
	}
}

/** Scan project dependencies for known vulnerabilities using osv-scanner.
 *  Returns blocking PendingFix[] for critical/high severity.
 *  Moderate/low are emitted as advisory to stderr.
 *  Fail-open: returns [] on any error. */
export function scanDependencyVulns(cwd: string): PendingFix[] {
	if (isGateDisabled("dep-vuln-check")) return [];

	const raw = runOsvScanner(["--format", "json", "-r", "."], cwd, SCAN_TIMEOUT);
	if (!raw) return [];

	try {
		return parseOsvOutput(raw);
	} catch {
		return [];
	}
}

/** Parse osv-scanner JSON output into PendingFix[]. */
function parseOsvOutput(raw: string): PendingFix[] {
	const data: OsvResult = JSON.parse(raw);
	if (!data.results || !Array.isArray(data.results)) return [];

	const blockingFixes: PendingFix[] = [];

	for (const result of data.results) {
		const sourceFile = result.source?.path ?? "(unknown)";

		for (const pkg of result.packages ?? []) {
			const name = pkg.package?.name ?? "unknown";
			const version = pkg.package?.version ?? "?";

			for (const vuln of pkg.vulnerabilities ?? []) {
				const severity = getSeverity(vuln);
				const id = vuln.id ?? "unknown";
				const summary = vuln.summary ?? "";
				const desc = `[${severity}] ${name}@${version} — ${id}: ${summary}`.slice(0, 300);

				if (BLOCKING_SEVERITIES.has(severity)) {
					// Find existing fix for this file or create new
					const existing = blockingFixes.find((f) => f.file === sourceFile);
					if (existing) {
						existing.errors.push(desc);
					} else {
						blockingFixes.push({
							file: sourceFile,
							gate: "dep-vuln-check",
							errors: [desc],
						});
					}
				} else {
					// Advisory only — emit to stderr
					process.stderr.write(`[qult] dep-vuln advisory: ${desc}\n`);
				}
			}
		}
	}

	return blockingFixes;
}
