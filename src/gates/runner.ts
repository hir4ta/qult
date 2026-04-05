import { exec, execSync } from "node:child_process";
import { loadConfig } from "../config.ts";
import type { GateDefinition } from "../types.ts";

/** Shell-escape a string for safe interpolation into a shell command. */
export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface GateResult {
	name: string;
	passed: boolean;
	output: string;
	duration_ms: number;
}

const ERROR_CODE_RE = /\b([A-Z]{1,4}\d{4,5})\b/;

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

/** Run a single gate command asynchronously. Returns pass/fail + output + duration. */
export function runGateAsync(
	name: string,
	gate: GateDefinition,
	file?: string,
): Promise<GateResult> {
	const config = loadConfig();
	const command = file ? gate.command.replace("{file}", shellEscape(file)) : gate.command;
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
					PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}`,
				},
				encoding: "utf-8",
			},
			(err, stdout, stderr) => {
				const duration_ms = Date.now() - start;
				if (err) {
					const raw = (stdout ?? "") + (stderr ?? "");
					const output =
						smartTruncate(deduplicateErrors(raw), maxChars) || `Exit code ${err.code ?? 1}`;
					resolve({ name, passed: false, output, duration_ms });
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
				PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}`,
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
		const output =
			smartTruncate(deduplicateErrors(stdout + stderr), maxChars) || `Exit code ${status}`;
		return {
			name,
			passed: false,
			output,
			duration_ms,
		};
	}
}
