/**
 * Minimal argv parser — splits a `process.argv.slice(2)` array into
 * positionals and flags. Zero dependencies. Flags that take values are
 * declared by the caller via `valueFlags`.
 *
 * Examples:
 *   parseArgs(["init", "--agent", "claude", "--force"], ["agent"])
 *     => { positionals: ["init"], flags: { agent: "claude", force: true } }
 */

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
				flags[a.slice(2, eq)] = a.slice(eq + 1);
				continue;
			}
			const name = a.slice(2);
			if (valueSet.has(name) && i + 1 < argv.length && !argv[i + 1]?.startsWith("-")) {
				flags[name] = argv[i + 1] as string;
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
