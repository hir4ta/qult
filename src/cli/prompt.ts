/**
 * Tiny interactive select UI for TTY environments.
 *
 * Uses `node:readline.question` instead of @clack/prompts to keep
 * `dependencies` empty. Callers must check `isTTY()` before invoking;
 * non-TTY runs should fall back without prompting.
 */

import { createInterface } from "node:readline";

export function isTTY(): boolean {
	return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export interface SelectOption<T> {
	label: string;
	value: T;
}

/** Print the options, read a 1-based index from stdin, return the selected value. */
export async function selectOne<T>(message: string, options: SelectOption<T>[]): Promise<T> {
	if (options.length === 0) throw new Error("selectOne: no options provided");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write(`${message}\n`);
		options.forEach((o, i) => {
			process.stdout.write(`  ${i + 1}) ${o.label}\n`);
		});
		while (true) {
			const ans = await new Promise<string>((res) => {
				rl.question(`Select [1-${options.length}]: `, (a) => res(a.trim()));
			});
			const idx = Number.parseInt(ans, 10);
			if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) {
				return options[idx - 1]!.value;
			}
			process.stderr.write(`Invalid selection: ${ans}\n`);
		}
	} finally {
		rl.close();
	}
}

/** Multi-select via comma-separated indices. */
export async function selectMany<T>(message: string, options: SelectOption<T>[]): Promise<T[]> {
	if (options.length === 0) return [];
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write(`${message}\n`);
		options.forEach((o, i) => {
			process.stdout.write(`  ${i + 1}) ${o.label}\n`);
		});
		while (true) {
			const ans = await new Promise<string>((res) => {
				rl.question(`Select indices (comma-separated, e.g. 1,3): `, (a) => res(a.trim()));
			});
			const parts = ans
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			const idxs = parts.map((p) => Number.parseInt(p, 10));
			if (
				idxs.length > 0 &&
				idxs.every((n) => Number.isInteger(n) && n >= 1 && n <= options.length)
			) {
				return idxs.map((i) => options[i - 1]!.value);
			}
			process.stderr.write(`Invalid selection: ${ans}\n`);
		}
	} finally {
		rl.close();
	}
}

/** y/n confirm with default. */
export async function confirm(message: string, defaultYes = false): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const suffix = defaultYes ? "[Y/n]" : "[y/N]";
		const ans = await new Promise<string>((res) => {
			rl.question(`${message} ${suffix} `, (a) => res(a.trim().toLowerCase()));
		});
		if (ans === "") return defaultYes;
		return ans === "y" || ans === "yes";
	} finally {
		rl.close();
	}
}
