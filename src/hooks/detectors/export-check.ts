import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { isGateDisabled } from "../../state/gate-state.ts";
import type { PendingFix } from "../../types.ts";
import { sanitizeForStderr } from "../sanitize.ts";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const EXPORT_RE =
	/\bexport\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;

/** Extract function signatures: export function name(params) */
const FUNC_SIG_RE = /\bexport\s+(?:default\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;

/** Detect removed exports by comparing current file with git HEAD version.
 *  Returns PendingFix[] for deleted exports (L4: breaking change detection). */
export function detectExportBreakingChanges(file: string): PendingFix[] {
	if (isGateDisabled("export-check")) return [];
	const ext = extname(file).toLowerCase();
	if (!TS_JS_EXTS.has(ext)) return [];
	if (!existsSync(file)) return [];

	let oldContent: string;
	try {
		const cwd = process.cwd();
		if (!file.startsWith(`${cwd}/`) && file !== cwd) return [];
		const relPath = file.slice(cwd.length + 1);
		oldContent = execSync(`git show HEAD:${relPath}`, {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return []; // fail-open: file not in git, or git not available
	}

	const newContent = readFileSync(file, "utf-8");

	const oldExports = new Set<string>();
	for (const match of oldContent.matchAll(EXPORT_RE)) {
		oldExports.add(match[1]!);
	}

	const newExports = new Set<string>();
	for (const match of newContent.matchAll(EXPORT_RE)) {
		newExports.add(match[1]!);
	}

	const removed = [...oldExports].filter((name) => !newExports.has(name));

	// Detect signature changes (parameter count) for functions that still exist
	const oldSigs = new Map<string, number>();
	for (const match of oldContent.matchAll(FUNC_SIG_RE)) {
		const params = match[2]!.trim();
		oldSigs.set(match[1]!, params ? params.split(",").length : 0);
	}
	const signatureChanges: string[] = [];
	for (const match of newContent.matchAll(FUNC_SIG_RE)) {
		const name = match[1]!;
		const newParamCount = match[2]!.trim() ? match[2]!.trim().split(",").length : 0;
		const oldParamCount = oldSigs.get(name);
		if (oldParamCount !== undefined && oldParamCount !== newParamCount) {
			signatureChanges.push(
				`Signature change: "${sanitizeForStderr(name)}" params ${oldParamCount}→${newParamCount}. Consumers may break.`,
			);
		}
	}

	// Detect type/interface field changes
	const typeChanges = detectTypeFieldChanges(oldContent, newContent);

	const errors = [
		...removed.map((name) => `Breaking change: export "${sanitizeForStderr(name)}" was removed`),
		...signatureChanges,
		...typeChanges,
	];
	if (errors.length === 0) return [];

	return [{ file, errors, gate: "export-check" }];
}

/** Extract exported type/interface field counts and detect changes. */
function detectTypeFieldChanges(oldContent: string, newContent: string): string[] {
	const TYPE_DEF_RE = /\bexport\s+(?:type|interface)\s+(\w+)\s*(?:=\s*)?{([^}]*)}/g;
	const countFields = (body: string) =>
		body
			.split(/[;\n]/)
			.map((s) => s.trim())
			.filter((s) => s && !s.startsWith("//")).length;

	const oldTypes = new Map<string, number>();
	for (const m of oldContent.matchAll(TYPE_DEF_RE)) {
		oldTypes.set(m[1]!, countFields(m[2]!));
	}

	const changes: string[] = [];
	for (const m of newContent.matchAll(TYPE_DEF_RE)) {
		const name = m[1]!;
		const newFields = countFields(m[2]!);
		const oldFields = oldTypes.get(name);
		if (oldFields !== undefined && oldFields !== newFields) {
			changes.push(
				`Type change: "${sanitizeForStderr(name)}" fields ${oldFields}→${newFields}. Consumers may need updates.`,
			);
		}
	}
	return changes;
}
