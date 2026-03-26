import { execSync } from "node:child_process";
import type { GateDefinition } from "../types.ts";

export interface GateResult {
	name: string;
	passed: boolean;
	output: string;
}

/** Run a single gate command. Returns pass/fail + output. */
export function runGate(name: string, gate: GateDefinition, file?: string): GateResult {
	const command = file ? gate.command.replace("{file}", file) : gate.command;
	const timeout = gate.timeout ?? 10_000;

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
		const output = (stdout ?? "").slice(0, 1000);
		return { name, passed: true, output };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		const stdout = typeof e.stdout === "string" ? e.stdout : "";
		const stderr = typeof e.stderr === "string" ? e.stderr : "";
		const output = (stdout + stderr).slice(0, 1000);
		return {
			name,
			passed: false,
			output: output || `Exit code ${e.status ?? 1}`,
		};
	}
}
