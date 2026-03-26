/**
 * Duplicate code detection — function signature extraction.
 *
 * Research: GitClear 2025 shows AI code duplication rose from 8.3% to 12.3%.
 * Phase 1: regex-based extraction + Voyage search for similar functions.
 */

export interface FunctionSignature {
	name: string;
	file: string;
	line: number;
	params: string;
}

// TypeScript/JavaScript: function declarations and arrow functions
const TS_FUNC_RE = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
const TS_ARROW_RE =
	/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=]+)?\s*=>/g;

// Python: def statements
const PY_FUNC_RE = /def\s+(\w+)\s*\(([^)]*)\)/g;

// Go: func declarations
const GO_FUNC_RE = /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)/g;

/**
 * Extract function signatures from source file content.
 */
export function extractFunctionSignatures(filePath: string, content: string): FunctionSignature[] {
	const sigs: FunctionSignature[] = [];
	const lines = content.split("\n");

	let patterns: RegExp[];
	if (/\.[jt]sx?$/.test(filePath)) {
		patterns = [TS_FUNC_RE, TS_ARROW_RE];
	} else if (/\.py$/.test(filePath)) {
		patterns = [PY_FUNC_RE];
	} else if (/\.go$/.test(filePath)) {
		patterns = [GO_FUNC_RE];
	} else {
		return [];
	}

	for (let i = 0; i < lines.length; i++) {
		for (const re of patterns) {
			re.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = re.exec(lines[i]!)) !== null) {
				const name = match[1]!;
				// Skip test helpers, constructors, etc.
				if (name.startsWith("_") || name === "constructor") continue;
				sigs.push({
					name,
					file: filePath,
					line: i + 1,
					params: (match[2] ?? "").trim(),
				});
			}
		}
	}

	return sigs;
}

/**
 * Build a natural language query for vector search from signatures.
 */
export function buildSearchQuery(sigs: FunctionSignature[]): string {
	return sigs
		.map((s) => `function ${s.name}(${s.params})`)
		.join("; ")
		.slice(0, 500);
}
