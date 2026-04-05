import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { isGateDisabled } from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";
import { sanitizeForStderr } from "../sanitize.ts";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const EXPORT_RE =
	/\bexport\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;

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
	if (removed.length === 0) return [];

	return [
		{
			file,
			errors: removed.map(
				(name) => `Breaking change: export "${sanitizeForStderr(name)}" was removed`,
			),
			gate: "export-check",
		},
	];
}
