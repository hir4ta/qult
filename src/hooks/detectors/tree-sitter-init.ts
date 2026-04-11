import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Supported languages for Tree-sitter analysis. */
export type SupportedLanguage = "typescript" | "tsx" | "python" | "go" | "rust" | "ruby" | "java";

/** Map file extension to Tree-sitter language. Returns null for unsupported extensions. */
export function extToLanguage(ext: string): SupportedLanguage | null {
	const map: Record<string, SupportedLanguage> = {
		".ts": "typescript",
		".mts": "typescript",
		".cts": "typescript",
		".tsx": "tsx",
		".js": "typescript",
		".jsx": "tsx",
		".mjs": "typescript",
		".cjs": "typescript",
		".py": "python",
		".pyi": "python",
		".go": "go",
		".rs": "rust",
		".rb": "ruby",
		".java": "java",
		".kt": "java",
	};
	return map[ext.toLowerCase()] ?? null;
}

// Module-scoped state for lazy initialization
let _initDone = false;
const _languageCache = new Map<string, import("web-tree-sitter").Language>();

/** Resolve WASM file path with fallback locations. */
function resolveWasmPath(filename: string): string | null {
	const cwd = process.cwd();
	const candidates = [
		join(cwd, "plugin", "wasm", filename),
		join(dirname(dirname(dirname(__dirname))), "plugin", "wasm", filename),
	];

	if (filename.startsWith("tree-sitter-") && filename.endsWith(".wasm")) {
		const lang = filename.replace("tree-sitter-", "").replace(".wasm", "");
		candidates.push(join(cwd, "node_modules", "@lumis-sh", `wasm-${lang}`, filename));
	}

	if (filename === "web-tree-sitter.wasm") {
		candidates.push(join(cwd, "node_modules", "web-tree-sitter", filename));
	}

	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

/** Shared Tree-sitter AST node interface used by all detectors. */
export interface TSNode {
	type: string;
	text: string;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	childCount: number;
	children: TSNode[];
	child(index: number): TSNode | null;
	namedChildren: TSNode[];
	namedChild(index: number): TSNode | null;
	childForFieldName(name: string): TSNode | null;
}

export interface ParserResult {
	parser: import("web-tree-sitter").Parser;
	language: import("web-tree-sitter").Language;
	parse: (code: string) => import("web-tree-sitter").Tree | null;
}

/**
 * Initialize a Tree-sitter parser for the given language.
 * Returns null on failure (fail-open).
 * Language instances are cached.
 */
export async function initParser(lang: SupportedLanguage): Promise<ParserResult | null> {
	try {
		const { Parser, Language } = await import("web-tree-sitter");

		if (!_initDone) {
			const enginePath = resolveWasmPath("web-tree-sitter.wasm");
			if (!enginePath) return null;
			await Parser.init({ locateFile: () => enginePath });
			_initDone = true;
		}

		let language = _languageCache.get(lang);
		if (!language) {
			const grammarPath = resolveWasmPath(`tree-sitter-${lang}.wasm`);
			if (!grammarPath) return null;
			language = await Language.load(grammarPath);
			_languageCache.set(lang, language);
		}

		const parser = new Parser();
		parser.setLanguage(language);

		return {
			parser,
			language,
			parse: (code: string) => parser.parse(code),
		};
	} catch {
		return null;
	}
}

/** Reset parser cache (for testing). */
export function resetParserCache(): void {
	_initDone = false;
	_languageCache.clear();
}
