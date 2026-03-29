import { execSync } from "node:child_process";
import { loadConfig } from "../config.ts";
import type { GateDefinition } from "../types.ts";

export interface GateResult {
	name: string;
	passed: boolean;
	output: string;
	duration_ms: number;
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

/** Run a single gate command. Returns pass/fail + output + duration. */
export function runGate(name: string, gate: GateDefinition, file?: string): GateResult {
	const config = loadConfig();
	const command = file ? gate.command.replace("{file}", file) : gate.command;
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
		const e = err as { stdout?: string; stderr?: string; status?: number };
		const stdout = typeof e.stdout === "string" ? e.stdout : "";
		const stderr = typeof e.stderr === "string" ? e.stderr : "";
		const output = smartTruncate(stdout + stderr, maxChars) || `Exit code ${e.status ?? 1}`;
		return {
			name,
			passed: false,
			output,
			duration_ms,
		};
	}
}
