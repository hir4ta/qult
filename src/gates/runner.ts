import { exec, execSync } from "node:child_process";
import { loadConfig } from "../config.ts";
import {
	type ClassifiedDiagnostic,
	parseCargoOutput,
	parseGoVetOutput,
	parseMypyOutput,
	parsePyrightOutput,
	parseTscOutput,
} from "../hooks/detectors/diagnostic-classifier.ts";
import type { GateDefinition } from "../types.ts";
import { parseCoveragePercent } from "./coverage-parser.ts";

/** Shell-escape a string for safe interpolation into a shell command.
 *  Wraps in single quotes and escapes single quotes + backticks to prevent injection. */
export function shellEscape(s: string): string {
	// Replace single quotes and backticks to prevent shell injection
	const escaped = s.replace(/'/g, "'\\''").replace(/`/g, "'\\`'");
	return `'${escaped}'`;
}

export interface GateResult {
	name: string;
	passed: boolean;
	output: string;
	duration_ms: number;
	classifiedDiagnostics?: ClassifiedDiagnostic[];
}

const ERROR_CODE_RE = /\b([A-Z]{1,4}\d{1,5}|ERR_[A-Z_]+|E\d{3,5})\b/;

/** Deduplicate lines sharing the same error code. Keeps first occurrence + summary. */
export function deduplicateErrors(text: string): string {
	const lines = text.split("\n");
	const codeGroups = new Map<string, { first: number; count: number }>();
	const lineCodes: (string | null)[] = [];

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]!.match(ERROR_CODE_RE);
		const code = match ? match[1]! : null;
		lineCodes.push(code);
		if (code) {
			const existing = codeGroups.get(code);
			if (existing) {
				existing.count++;
			} else {
				codeGroups.set(code, { first: i, count: 1 });
			}
		}
	}

	// If no deduplication possible, return as-is
	const hasRepeats = [...codeGroups.values()].some((g) => g.count > 1);
	if (!hasRepeats) return text;

	const result: string[] = [];
	const emittedSummary = new Set<string>();

	for (let i = 0; i < lines.length; i++) {
		const code = lineCodes[i];
		if (!code) {
			result.push(lines[i]!);
			continue;
		}
		const group = codeGroups.get(code)!;
		if (group.count === 1) {
			result.push(lines[i]!);
		} else if (i === group.first) {
			result.push(lines[i]!);
			if (!emittedSummary.has(code)) {
				result.push(`... and ${group.count - 1} more ${code} errors`);
				emittedSummary.add(code);
			}
		}
		// skip duplicate lines
	}

	return result.join("\n");
}

/** Smart truncation: keep head + tail with truncation marker in between. */
export function smartTruncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const headSize = Math.floor(maxChars * 0.75);
	const tailSize = maxChars - headSize;
	const truncated = text.length - headSize - tailSize;
	const head = text.slice(0, headSize);
	const tail = text.slice(-tailSize);
	return `${head}\n... (${truncated} chars truncated) ...\n${tail}`;
}

/** Build PATH env with extra_path + node_modules/.bin prepended. */
function buildPath(extraPaths: string[]): string {
	const cwd = process.cwd();
	const extra = extraPaths
		.filter((p) => !p.includes(":")) // reject paths with colon (PATH injection)
		.map((p) => (p.startsWith("/") ? p : `${cwd}/${p}`))
		.join(":");
	const prefix = extra ? `${extra}:` : "";
	return `${prefix}${cwd}/node_modules/.bin:${process.env.PATH}`;
}

/** Run a single gate command asynchronously. Returns pass/fail + output + duration. */
export function runGateAsync(
	name: string,
	gate: GateDefinition,
	file?: string,
): Promise<GateResult> {
	const config = loadConfig();
	const baseCmd = gate.structured_command ?? gate.command;
	const command = file ? baseCmd.replace("{file}", shellEscape(file)) : baseCmd;
	const timeout = gate.timeout ?? config.gates.default_timeout;
	const maxChars = config.gates.output_max_chars;
	const start = Date.now();

	return new Promise((resolve) => {
		exec(
			command,
			{
				cwd: process.cwd(),
				timeout,
				env: {
					...process.env,
					PATH: buildPath(config.gates.extra_path),
				},
				encoding: "utf-8",
			},
			(err, stdout, stderr) => {
				const duration_ms = Date.now() - start;
				if (err) {
					const raw = (stdout ?? "") + (stderr ?? "");
					const isTimeout = "killed" in err && err.killed && duration_ms >= timeout - 100;
					const prefix = isTimeout ? `TIMEOUT after ${timeout}ms\n` : "";
					const output =
						prefix +
						(smartTruncate(deduplicateErrors(raw), maxChars) || `Exit code ${err.code ?? 1}`);
					const classified = classifyTypecheckOutput(name, command, raw);
					resolve({ name, passed: false, output, duration_ms, ...classified });
				} else {
					const output = smartTruncate(stdout ?? "", maxChars);
					resolve({ name, passed: true, output, duration_ms });
				}
			},
		);
	});
}

/** Run a single gate command (sync). Returns pass/fail + output + duration. */
export function runGate(name: string, gate: GateDefinition, file?: string): GateResult {
	const config = loadConfig();
	const command = file ? gate.command.replace("{file}", shellEscape(file)) : gate.command;
	const timeout = gate.timeout ?? config.gates.default_timeout;
	const maxChars = config.gates.output_max_chars;
	const start = Date.now();

	try {
		const stdout = execSync(command, {
			cwd: process.cwd(),
			timeout,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PATH: buildPath(config.gates.extra_path),
			},
			encoding: "utf-8",
		});
		const output = smartTruncate(stdout ?? "", maxChars);
		return { name, passed: true, output, duration_ms: Date.now() - start };
	} catch (err: unknown) {
		const duration_ms = Date.now() - start;
		const e = err != null && typeof err === "object" ? err : {};
		const stdout = "stdout" in e && typeof e.stdout === "string" ? e.stdout : "";
		const stderr = "stderr" in e && typeof e.stderr === "string" ? e.stderr : "";
		const status = "status" in e && typeof e.status === "number" ? e.status : 1;
		const isTimeout = "signal" in e && e.signal === "SIGTERM" && duration_ms >= timeout - 100;
		const prefix = isTimeout ? `TIMEOUT after ${timeout}ms\n` : "";
		const output =
			prefix +
			(smartTruncate(deduplicateErrors(stdout + stderr), maxChars) || `Exit code ${status}`);
		return {
			name,
			passed: false,
			output,
			duration_ms,
		};
	}
}

/** Classify typecheck gate output into diagnostic categories.
 *  Only runs for gates named "typecheck". Returns partial GateResult with classifiedDiagnostics. */
function classifyTypecheckOutput(
	gateName: string,
	_command: string,
	raw: string,
): { classifiedDiagnostics?: ClassifiedDiagnostic[] } {
	if (gateName !== "typecheck" || !raw) return {};
	try {
		let diagnostics: ClassifiedDiagnostic[] = [];

		// Try structured JSON parsers first
		if (raw.includes('"generalDiagnostics"')) {
			diagnostics = parsePyrightOutput(raw);
		} else if (raw.includes('"compiler-message"')) {
			diagnostics = parseCargoOutput(raw);
		}

		// Try language-specific text parsers
		if (diagnostics.length === 0 && raw.includes(": error: ") && raw.includes("[")) {
			diagnostics = parseMypyOutput(raw);
		}
		if (diagnostics.length === 0 && /\.go:\d+:\d+:/.test(raw)) {
			diagnostics = parseGoVetOutput(raw);
		}

		// Fallback: tsc text output
		if (diagnostics.length === 0) {
			diagnostics = parseTscOutput(raw);
		}

		return diagnostics.length > 0 ? { classifiedDiagnostics: diagnostics } : {};
	} catch {
		return {}; // fail-open
	}
}

/** Run a coverage gate: execute the test command, then check coverage percentage against threshold.
 *  Returns pass if threshold=0 (disabled), test fails (fail handled by test gate), or coverage >= threshold.
 *  Fail-open: if coverage output cannot be parsed, passes (coverage data may not be present). */
export function runCoverageGate(name: string, gate: GateDefinition, threshold: number): GateResult {
	if (threshold <= 0) {
		return { name, passed: true, output: "coverage check skipped (threshold=0)", duration_ms: 0 };
	}

	const result = runGate(name, gate);

	// If the underlying test command failed, propagate that failure
	if (!result.passed) return result;

	// Parse coverage from output
	const coverage = parseCoveragePercent(result.output);

	// Fail-open: if coverage output can't be parsed, pass
	if (coverage === null) return result;

	if (coverage < threshold) {
		return {
			name,
			passed: false,
			output: `Coverage ${coverage}% is below threshold ${threshold}%`,
			duration_ms: result.duration_ms,
		};
	}

	return result;
}
