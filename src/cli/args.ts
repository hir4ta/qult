/**
 * Minimal argv parser — splits a `process.argv.slice(2)` array into
 * positionals and flags. Zero dependencies. Flags that take values are
 * declared by the caller via `valueFlags`.
 *
 * Examples:
 *   parseArgs(["init", "--agent", "claude", "--force"], ["agent"])
 *     => { positionals: ["init"], flags: { agent: "claude", force: true } }
 */

/** Thrown when argv is malformed (e.g. value-flag without a value). */
export class ArgsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArgsError";
	}
}

export interface ParsedArgs {
	positionals: string[];
	flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[], valueFlags: string[] = []): ParsedArgs {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	const valueSet = new Set(valueFlags);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq !== -1) {
				const name = a.slice(2, eq);
				const value = a.slice(eq + 1);
				if (valueSet.has(name) && value.length === 0) {
					throw new ArgsError(`flag --${name} requires a non-empty value`);
				}
				flags[name] = value;
				continue;
			}
			const name = a.slice(2);
			if (valueSet.has(name)) {
				const next = argv[i + 1];
				if (next === undefined || next.startsWith("-")) {
					throw new ArgsError(`flag --${name} requires a value`);
				}
				flags[name] = next;
				i++;
			} else {
				flags[name] = true;
			}
			continue;
		}
		if (a.startsWith("-") && a.length > 1) {
			// Short flag — boolean only.
			flags[a.slice(1)] = true;
			continue;
		}
		positionals.push(a);
	}
	return { positionals, flags };
}
