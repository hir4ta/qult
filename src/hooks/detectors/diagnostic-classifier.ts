import type { PendingFix } from "../../types.ts";

/** Classified diagnostic category */
export type DiagnosticCategory =
	| "hallucinated-api"
	| "hallucinated-symbol"
	| "hallucinated-import"
	| "type-error"
	| "unknown";

/** A single classified diagnostic from a type checker */
export interface ClassifiedDiagnostic {
	code: string;
	category: DiagnosticCategory;
	message: string;
	file: string;
	line: number;
}

/**
 * Mapping of error codes to diagnostic categories.
 * Categories:
 *   hallucinated-api    — method/property that doesn't exist on a type
 *   hallucinated-symbol — name that doesn't exist in scope
 *   hallucinated-import — module/package that doesn't exist
 *   type-error          — genuine type mismatch (not hallucination)
 */
export const DIAGNOSTIC_MAP: Record<string, DiagnosticCategory> = {
	// TypeScript — hallucinated API (property/method doesn't exist)
	TS2339: "hallucinated-api", // Property 'X' does not exist on type 'Y'
	TS2551: "hallucinated-api", // Property 'X' does not exist on type 'Y'. Did you mean 'Z'?
	TS2459: "hallucinated-api", // Module '"X"' has no exported member 'Y'
	TS2694: "hallucinated-api", // Namespace '"X"' has no exported member 'Y'

	// TypeScript — hallucinated symbol (name doesn't exist in scope)
	TS2304: "hallucinated-symbol", // Cannot find name 'X'
	TS2552: "hallucinated-symbol", // Cannot find name 'X'. Did you mean 'Y'?
	TS2580: "hallucinated-symbol", // Cannot find name 'require'

	// TypeScript — hallucinated import (module doesn't exist)
	TS2307: "hallucinated-import", // Cannot find module 'X'
	TS2792: "hallucinated-import", // Cannot find module 'X'. Did you mean ...?

	// TypeScript — type errors (genuine, not hallucination)
	TS2322: "type-error", // Type 'X' is not assignable to type 'Y'
	TS2345: "type-error", // Argument of type 'X' is not assignable to parameter of type 'Y'
	TS2741: "type-error", // Property 'X' is missing in type 'Y'
	TS2769: "type-error", // No overload matches this call

	// Pyright — hallucinated API
	reportAttributeAccessIssue: "hallucinated-api",
	reportFunctionMemberAccess: "hallucinated-api",

	// Pyright — hallucinated symbol
	reportUndefinedVariable: "hallucinated-symbol",
	reportMissingTypeStubs: "hallucinated-symbol",

	// Pyright — hallucinated import
	reportMissingImports: "hallucinated-import",
	reportMissingModuleSource: "hallucinated-import",

	// Pyright — type errors
	reportArgumentType: "type-error",
	reportReturnType: "type-error",
	reportAssignmentType: "type-error",
	reportIndexIssue: "type-error",

	// Cargo (Rust) — hallucinated API
	E0599: "hallucinated-api", // no method named 'X' found

	// Cargo — hallucinated symbol
	E0425: "hallucinated-symbol", // cannot find value 'X' in this scope
	E0412: "hallucinated-symbol", // cannot find type 'X' in this scope

	// Cargo — hallucinated import
	E0432: "hallucinated-import", // unresolved import
	E0433: "hallucinated-import", // failed to resolve: use of undeclared crate or module

	// Cargo — type errors
	E0308: "type-error", // mismatched types
	E0277: "type-error", // the trait bound is not satisfied

	// Mypy — hallucinated symbol/import
	"name-defined": "hallucinated-symbol", // Name "X" is not defined
	import: "hallucinated-import", // Cannot find implementation or library stub for module "X"
	"import-untyped": "hallucinated-import", // Library stubs not installed for "X"
	"attr-defined": "hallucinated-api", // "Foo" has no attribute "bar"

	// Mypy — type errors
	"arg-type": "type-error", // Argument of type "X" is not assignable
	assignment: "type-error", // Incompatible types in assignment
	"return-value": "type-error", // Incompatible return value type
	override: "type-error", // Return type incompatible with supertype

	// Go vet — not code-based but message-based (handled in parseGoVetOutput)
};

// tsc output format: file(line,col): error TSxxxx: message
const TSC_LINE_RE = /^(.+)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/;

/** Parse tsc text output into classified diagnostics. */
export function parseTscOutput(raw: string): ClassifiedDiagnostic[] {
	if (!raw) return [];
	const results: ClassifiedDiagnostic[] = [];
	for (const line of raw.split("\n")) {
		const m = line.match(TSC_LINE_RE);
		if (!m) continue;
		const [, file, lineStr, code, message] = m;
		results.push({
			code: code!,
			category: DIAGNOSTIC_MAP[code!] ?? "unknown",
			message: message!,
			file: file!,
			line: Number(lineStr),
		});
	}
	return results;
}

interface PyrightDiagnostic {
	file: string;
	range: { start: { line: number } };
	rule?: string;
	message: string;
}

/** Parse pyright --outputjson output into classified diagnostics. */
export function parsePyrightOutput(raw: string): ClassifiedDiagnostic[] {
	try {
		const parsed = JSON.parse(raw) as { generalDiagnostics?: PyrightDiagnostic[] };
		const diagnostics = parsed?.generalDiagnostics;
		if (!Array.isArray(diagnostics)) return [];
		return diagnostics
			.filter((d) => d.rule)
			.map((d) => ({
				code: d.rule!,
				category: (DIAGNOSTIC_MAP[d.rule!] ?? "type-error") as DiagnosticCategory,
				message: d.message,
				file: d.file,
				line: d.range.start.line,
			}));
	} catch {
		return [];
	}
}

interface CargoMessage {
	reason: string;
	message?: {
		code: { code: string } | null;
		message: string;
		spans: { file_name: string; line_start: number }[];
	};
}

/** Parse cargo check --message-format=json JSONL output into classified diagnostics. */
export function parseCargoOutput(raw: string): ClassifiedDiagnostic[] {
	if (!raw) return [];
	const results: ClassifiedDiagnostic[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as CargoMessage;
			if (parsed.reason !== "compiler-message") continue;
			const msg = parsed.message;
			if (!msg?.code?.code || !msg.spans.length) continue;
			const span = msg.spans[0]!;
			results.push({
				code: msg.code.code,
				category: (DIAGNOSTIC_MAP[msg.code.code] ?? "unknown") as DiagnosticCategory,
				message: msg.message,
				file: span.file_name,
				line: span.line_start,
			});
		} catch {
			// skip malformed lines
		}
	}
	return results;
}

// mypy output format: file:line: error: message [code]
const MYPY_LINE_RE = /^(.+):(\d+):\s*error:\s*(.+?)\s*\[([^\]]+)\]$/;

/** Parse mypy text output into classified diagnostics. */
export function parseMypyOutput(raw: string): ClassifiedDiagnostic[] {
	if (!raw) return [];
	const results: ClassifiedDiagnostic[] = [];
	for (const line of raw.split("\n")) {
		const m = line.match(MYPY_LINE_RE);
		if (!m) continue;
		const [, file, lineStr, message, code] = m;
		results.push({
			code: code!,
			category: (DIAGNOSTIC_MAP[code!] ?? "type-error") as DiagnosticCategory,
			message: message!,
			file: file!,
			line: Number(lineStr),
		});
	}
	return results;
}

// go vet output format: ./file.go:line:col: message
const GO_VET_LINE_RE = /^\.?\/?([\w/.]+\.go):(\d+):\d+:\s*(.+)$/;

/** Parse go vet text output into classified diagnostics.
 *  Go vet doesn't use error codes — classify by message patterns. */
export function parseGoVetOutput(raw: string): ClassifiedDiagnostic[] {
	if (!raw) return [];
	const results: ClassifiedDiagnostic[] = [];
	for (const line of raw.split("\n")) {
		const m = line.match(GO_VET_LINE_RE);
		if (!m) continue;
		const [, file, lineStr, message] = m;
		let category: DiagnosticCategory = "type-error";
		if (/undefined:|undeclared name:/.test(message!)) {
			category = "hallucinated-symbol";
		} else if (/could not import|cannot find package/.test(message!)) {
			category = "hallucinated-import";
		} else if (/has no field or method/.test(message!)) {
			category = "hallucinated-api";
		}
		results.push({
			code: "go-vet",
			category,
			message: message!,
			file: file!,
			line: Number(lineStr),
		});
	}
	return results;
}

/** Convert classified diagnostics to PendingFix[], grouped by file.
 *  Skips "unknown" category diagnostics. Gate is always "typecheck". */
export function classifiedToPendingFixes(diagnostics: ClassifiedDiagnostic[]): PendingFix[] {
	const actionable = diagnostics.filter((d) => d.category !== "unknown");
	if (!actionable.length) return [];

	const byFile = new Map<string, string[]>();
	for (const d of actionable) {
		const errors = byFile.get(d.file) ?? [];
		errors.push(`[${d.category}] ${d.message}`);
		byFile.set(d.file, errors);
	}

	return [...byFile.entries()].map(([file, errors]) => ({
		file,
		errors,
		gate: "typecheck",
	}));
}
