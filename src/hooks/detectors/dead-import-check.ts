import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { isGateDisabled } from "../../state/session-state.ts";
import { sanitizeForStderr } from "../sanitize.ts";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const PY_EXTS = new Set([".py", ".pyi"]);
const MAX_CHECK_SIZE = 500_000;

/** Named import with alias tracking: import { Foo as Bar } → name="Foo", alias="Bar" */
interface ImportedName {
	name: string;
	alias: string;
}

// ── TypeScript/JavaScript ────────────────────────────────────

// import X from 'mod'
const DEFAULT_IMPORT_RE = /^\s*import\s+(\w+)\s+from\s+["']/;
// import { X, Y as Z } from 'mod'
const NAMED_IMPORT_RE = /^\s*import\s*\{([^}]+)\}\s*from\s+["']/;
// import * as X from 'mod'
const NAMESPACE_IMPORT_RE = /^\s*import\s+\*\s+as\s+(\w+)\s+from\s+["']/;
// Side-effect imports: import 'mod' — always used, skip
const SIDE_EFFECT_RE = /^\s*import\s+["']/;
// Re-exports: export { X } from 'mod' — always used, skip
const REEXPORT_RE = /^\s*export\s+\{[^}]*\}\s+from\s+["']/;
// Type-only imports: import type { X } from 'mod'
const TYPE_IMPORT_RE = /^\s*import\s+type\s+\{([^}]+)\}\s*from\s+["']/;

// ── Python ───────────────────────────────────────────────────

// from mod import X, Y as Z
const PY_FROM_IMPORT_RE = /^\s*from\s+\S+\s+import\s+(.+)/;
// import X, Y
const PY_IMPORT_RE = /^\s*import\s+(.+)/;

/** Detect unused imports in an edited file. Returns warning strings (advisory, non-blocking).
 *  This is a heuristic based on text search — not AST. Errs on the side of not reporting
 *  (skip if uncertain) to minimize false positives. */
export function detectDeadImports(file: string): string[] {
	if (isGateDisabled("dead-import-check")) return [];
	const ext = extname(file).toLowerCase();
	if (!TS_JS_EXTS.has(ext) && !PY_EXTS.has(ext)) return [];
	if (!existsSync(file)) return [];

	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	if (content.length > MAX_CHECK_SIZE) return [];

	if (PY_EXTS.has(ext)) return detectDeadPythonImports(content);
	return detectDeadTsJsImports(content);
}

function detectDeadTsJsImports(content: string): string[] {
	const lines = content.split("\n");
	const imports: { name: string; line: number }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (
			SIDE_EFFECT_RE.test(line) &&
			!DEFAULT_IMPORT_RE.test(line) &&
			!NAMED_IMPORT_RE.test(line) &&
			!NAMESPACE_IMPORT_RE.test(line)
		)
			continue;
		if (REEXPORT_RE.test(line)) continue;

		// Type-only imports
		const typeMatch = line.match(TYPE_IMPORT_RE);
		if (typeMatch) {
			for (const imp of parseNamedImports(typeMatch[1]!)) {
				imports.push({ name: imp.alias, line: i + 1 });
			}
			continue;
		}

		// Default import
		const defaultMatch = line.match(DEFAULT_IMPORT_RE);
		if (defaultMatch) {
			imports.push({ name: defaultMatch[1]!, line: i + 1 });
		}

		// Named imports
		const namedMatch = line.match(NAMED_IMPORT_RE);
		if (namedMatch) {
			for (const imp of parseNamedImports(namedMatch[1]!)) {
				imports.push({ name: imp.alias, line: i + 1 });
			}
		}

		// Namespace import
		const nsMatch = line.match(NAMESPACE_IMPORT_RE);
		if (nsMatch) {
			imports.push({ name: nsMatch[1]!, line: i + 1 });
		}
	}

	// Check usage: search for each import name in the rest of the code
	// Remove import lines from content for usage search
	const codeWithoutImports = lines
		.filter((line) => !line.trimStart().startsWith("import "))
		.join("\n");

	const warnings: string[] = [];
	for (const { name, line } of imports) {
		// Use word boundary to match usage
		const usageRe = new RegExp(`\\b${escapeRegex(name)}\\b`);
		if (!usageRe.test(codeWithoutImports)) {
			warnings.push(sanitizeForStderr(`L${line}: unused import "${name}" — consider removing`));
		}
	}

	return warnings;
}

function detectDeadPythonImports(content: string): string[] {
	const lines = content.split("\n");
	const imports: { name: string; line: number }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trimStart().startsWith("#")) continue;

		// from X import Y, Z as W
		const fromMatch = line.match(PY_FROM_IMPORT_RE);
		if (fromMatch) {
			const names = fromMatch[1]!
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			for (const n of names) {
				// Handle "X as Y"
				const parts = n.split(/\s+as\s+/);
				const alias = (parts.length > 1 ? parts[1] : parts[0])!.trim();
				if (alias === "*") continue; // from X import *
				if (/^\w+$/.test(alias)) {
					imports.push({ name: alias, line: i + 1 });
				}
			}
			continue;
		}

		// import X, Y
		const importMatch = line.match(PY_IMPORT_RE);
		if (importMatch) {
			const names = importMatch[1]!
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			for (const n of names) {
				const parts = n.split(/\s+as\s+/);
				const alias = (parts.length > 1 ? parts[1] : parts[0])!.trim();
				// Only top-level module name (e.g., "os" from "import os.path")
				const topName = alias.split(".")[0]!;
				if (/^\w+$/.test(topName)) {
					imports.push({ name: topName, line: i + 1 });
				}
			}
		}
	}

	// Remove import lines for usage search
	const codeWithoutImports = lines
		.filter(
			(line) => !line.trimStart().startsWith("import ") && !line.trimStart().startsWith("from "),
		)
		.join("\n");

	const warnings: string[] = [];
	for (const { name, line } of imports) {
		const usageRe = new RegExp(`\\b${escapeRegex(name)}\\b`);
		if (!usageRe.test(codeWithoutImports)) {
			warnings.push(sanitizeForStderr(`L${line}: unused import "${name}" — consider removing`));
		}
	}

	return warnings;
}

function parseNamedImports(raw: string): ImportedName[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((s) => {
			// Handle "type Foo" prefix (inline type imports)
			const withoutType = s.replace(/^type\s+/, "");
			const parts = withoutType.split(/\s+as\s+/);
			return {
				name: parts[0]!.trim(),
				alias: (parts.length > 1 ? parts[1] : parts[0])!.trim(),
			};
		})
		.filter(({ alias }) => /^\w+$/.test(alias));
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
