import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface GroundingResult {
	total: number;
	ungrounded: string[];
}

/** Extract file path references from reviewer findings and verify they exist.
 *  Pattern: [severity] filepath — description
 *  Also checks for backtick-quoted function names (`functionName`) in the same finding line. */
// File path must contain "/" or a file extension (e.g., "src/foo.ts", "foo.py")
// This prevents matching bare words like "minor" or "style" as file paths
// [^\s:] excludes colon from path so `:linenum` is parsed separately
const FINDING_FILE_RE =
	/\[(critical|high|medium|low)\]\s+((?:[^\s:]+\/[^\s:]+|[^\s:]+\.\w{1,5}))(?::(\d+))?\s+[—–]\s+(.+?)(?:\n|$)/gi;
const FUNC_REF_RE = /`([a-zA-Z_$][a-zA-Z0-9_$]*)`/g;
const MAX_FILE_SIZE = 500_000;

export function groundClaims(output: string, cwd: string): GroundingResult {
	try {
		const ungrounded: string[] = [];
		let total = 0;

		for (const match of output.matchAll(FINDING_FILE_RE)) {
			total++;
			const filePath = match[2]!;
			const description = match[4] ?? "";
			const absPath = join(cwd, filePath);

			// Path traversal prevention: reject paths that escape project root
			const normalizedCwd = cwd.replace(/\/+$/, "");
			if (!absPath.startsWith(`${normalizedCwd}/`)) {
				ungrounded.push(`Path traversal rejected: ${filePath}`);
				continue;
			}

			// Check file existence
			if (!existsSync(absPath)) {
				ungrounded.push(`File not found: ${filePath}`);
				continue;
			}

			// Check function name references in the description
			let fileContent: string | null = null;
			for (const funcMatch of description.matchAll(FUNC_REF_RE)) {
				const funcName = funcMatch[1]!;
				if (!fileContent) {
					try {
						const size = statSync(absPath).size;
						if (size > MAX_FILE_SIZE) break;
						fileContent = readFileSync(absPath, "utf-8");
					} catch {
						break; // fail-open: can't read file, skip function checks
					}
				}
				// Word-boundary check: function/method/variable name appears as a distinct token
				const escaped = funcName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				// nosemgrep: detect-non-literal-regexp — input is escapeRegex'd internal symbol name, not user input
				const wordRe = new RegExp(`\\b${escaped}\\b`);
				if (!wordRe.test(fileContent)) {
					ungrounded.push(`Symbol \`${funcName}\` not found in ${filePath}`);
				}
			}
		}

		return { total, ungrounded };
	} catch {
		// fail-open
		return { total: 0, ungrounded: [] };
	}
}
