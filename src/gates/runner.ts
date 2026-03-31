import { exec, execSync } from "node:child_process";
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

/** Run a single gate command asynchronously. Returns pass/fail + output + duration. */
export function runGateAsync(
	name: string,
	gate: GateDefinition,
	file?: string,
): Promise<GateResult> {
	const config = loadConfig();
	const command = file ? gate.command.replace("{file}", file) : gate.command;
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
					const output =
						smartTruncate((stdout ?? "") + (stderr ?? ""), maxChars) ||
						`Exit code ${err.code ?? 1}`;
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
		const e = err != null && typeof err === "object" ? err : {};
		const stdout = "stdout" in e && typeof e.stdout === "string" ? e.stdout : "";
		const stderr = "stderr" in e && typeof e.stderr === "string" ? e.stderr : "";
		const status = "status" in e && typeof e.status === "number" ? e.status : 1;
		const output = smartTruncate(stdout + stderr, maxChars) || `Exit code ${status}`;
		return {
			name,
			passed: false,
			output,
			duration_ms,
		};
	}
}
