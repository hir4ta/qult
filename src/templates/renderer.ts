/**
 * Zero-dependency `{{VAR}}` template renderer.
 *
 * Substitution rules:
 *  - `{{VAR}}` where VAR matches `[A-Z0-9_]+` is replaced with `vars[VAR]`.
 *  - Any placeholder whose key is not in `vars` causes `UndefinedVariableError`.
 *  - No conditionals, no loops, no filters (KISS — design.md alternatives-considered).
 *
 * The CLI catches `UndefinedVariableError` and skips the offending template
 * with a stderr warning, per requirements.md.
 */

const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

export class UndefinedVariableError extends Error {
	readonly missing: string[];
	constructor(missing: string[]) {
		super(`undefined template variables: ${missing.join(", ")}`);
		this.name = "UndefinedVariableError";
		this.missing = missing;
	}
}

/**
 * Replace every `{{VAR}}` in `template` with `vars[VAR]`.
 * Throws `UndefinedVariableError` listing every placeholder that lacks a value.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
	const missing = new Set<string>();
	for (const match of template.matchAll(PLACEHOLDER_RE)) {
		const key = match[1];
		if (key && !(key in vars)) missing.add(key);
	}
	if (missing.size > 0) throw new UndefinedVariableError([...missing].sort());
	return template.replace(PLACEHOLDER_RE, (_, key: string) => vars[key] ?? "");
}

/**
 * Inspect a template and throw if any placeholder is undefined; do not render.
 * Useful when you want to validate templates before any side-effecting writes.
 */
export function detectUndefinedVars(template: string, vars: Record<string, string>): void {
	const missing = new Set<string>();
	for (const match of template.matchAll(PLACEHOLDER_RE)) {
		const key = match[1];
		if (key && !(key in vars)) missing.add(key);
	}
	if (missing.size > 0) throw new UndefinedVariableError([...missing].sort());
}
