import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { loadConfig } from "../../config.ts";
import { isGateDisabled } from "../../state/session-state.ts";
import {
	extToLanguage,
	initParser,
	type SupportedLanguage,
	type TSNode,
} from "./tree-sitter-init.ts";

const MAX_CHECK_SIZE = 500_000;

export interface FunctionComplexity {
	name: string;
	line: number;
	cyclomatic: number;
	cognitive: number;
	lineCount: number;
}

export interface ComplexityResult {
	functions: FunctionComplexity[];
	warnings: string[];
}

// ── Node type mappings per language ──────────────────────────

interface LanguageNodes {
	functionTypes: string[];
	branchTypes: string[];
	logicalOperatorTypes: string[];
	nestingTypes: string[];
	ternaryType: string | null;
}

const TS_NODES: LanguageNodes = {
	functionTypes: [
		"function_declaration",
		"arrow_function",
		"method_definition",
		"function_expression",
	],
	branchTypes: [
		"if_statement",
		"for_statement",
		"for_in_statement",
		"while_statement",
		"do_statement",
		"catch_clause",
		"switch_case",
	],
	logicalOperatorTypes: ["&&", "||", "??"],
	nestingTypes: [
		"if_statement",
		"for_statement",
		"for_in_statement",
		"while_statement",
		"do_statement",
		"switch_statement",
		"catch_clause",
	],
	ternaryType: "ternary_expression",
};

const PYTHON_NODES: LanguageNodes = {
	functionTypes: ["function_definition"],
	branchTypes: ["if_statement", "elif_clause", "for_statement", "while_statement", "except_clause"],
	logicalOperatorTypes: ["and", "or"],
	nestingTypes: ["if_statement", "for_statement", "while_statement", "except_clause"],
	ternaryType: "conditional_expression",
};

const GO_NODES: LanguageNodes = {
	functionTypes: ["function_declaration", "method_declaration", "func_literal"],
	branchTypes: ["if_statement", "for_statement", "expression_case", "type_case", "default_case"],
	logicalOperatorTypes: ["&&", "||"],
	nestingTypes: ["if_statement", "for_statement", "select_statement"],
	ternaryType: null,
};

const RUST_NODES: LanguageNodes = {
	functionTypes: ["function_item"],
	branchTypes: ["if_expression", "for_expression", "while_expression", "match_arm"],
	logicalOperatorTypes: ["&&", "||"],
	nestingTypes: ["if_expression", "for_expression", "while_expression", "match_expression"],
	ternaryType: null,
};

const RUBY_NODES: LanguageNodes = {
	functionTypes: ["method", "singleton_method"],
	branchTypes: ["if", "elsif", "unless", "for", "while", "until", "when", "rescue"],
	logicalOperatorTypes: ["and", "or", "&&", "||"],
	nestingTypes: ["if", "unless", "for", "while", "until", "case"],
	ternaryType: "conditional",
};

const JAVA_NODES: LanguageNodes = {
	functionTypes: ["method_declaration", "constructor_declaration"],
	branchTypes: [
		"if_statement",
		"for_statement",
		"enhanced_for_statement",
		"while_statement",
		"do_statement",
		"catch_clause",
		"switch_block_statement_group",
	],
	logicalOperatorTypes: ["&&", "||"],
	nestingTypes: [
		"if_statement",
		"for_statement",
		"enhanced_for_statement",
		"while_statement",
		"do_statement",
		"switch_expression",
		"catch_clause",
	],
	ternaryType: "ternary_expression",
};

function getLanguageNodes(lang: SupportedLanguage): LanguageNodes {
	switch (lang) {
		case "typescript":
		case "tsx":
			return TS_NODES;
		case "python":
			return PYTHON_NODES;
		case "go":
			return GO_NODES;
		case "rust":
			return RUST_NODES;
		case "ruby":
			return RUBY_NODES;
		case "java":
			return JAVA_NODES;
	}
}

/**
 * Compute cyclomatic and cognitive complexity for all functions in a file.
 * Uses Tree-sitter AST for accurate function boundary and control flow detection.
 * Returns null for unsupported files or on error (fail-open).
 */
export async function computeComplexity(file: string): Promise<ComplexityResult | null> {
	if (isGateDisabled("complexity-check")) return null;

	try {
		const ext = extname(file).toLowerCase();
		const lang = extToLanguage(ext);
		if (!lang) return null;
		if (!existsSync(file)) return null;

		const content = readFileSync(file, "utf-8");
		if (content.length > MAX_CHECK_SIZE) return null;

		const result = await initParser(lang);
		if (!result) return null;

		const tree = result.parse(content);
		if (!tree) return null;

		const rootNode = (tree as { rootNode: TSNode }).rootNode;
		const langNodes = getLanguageNodes(lang);
		const config = loadConfig();

		const functions: FunctionComplexity[] = [];
		const warnings: string[] = [];

		// Find all function nodes and compute complexity for each
		findFunctions(rootNode, langNodes, functions);

		// Generate warnings
		for (const fn of functions) {
			if (fn.cyclomatic > config.gates.complexity_threshold) {
				warnings.push(
					`L${fn.line}: function "${fn.name}" has cyclomatic complexity ${fn.cyclomatic} (threshold: ${config.gates.complexity_threshold})`,
				);
			}
			if (fn.lineCount > config.gates.function_size_limit) {
				warnings.push(
					`L${fn.line}: function "${fn.name}" has ${fn.lineCount} lines (limit: ${config.gates.function_size_limit})`,
				);
			}
		}

		return { functions, warnings };
	} catch {
		return null; // fail-open
	}
}

// ── Cached sync wrapper for health-score integration ──

let _lastFile: string | null = null;
let _lastResult: ComplexityResult | null = null;

/**
 * Synchronous wrapper that returns cached result from last computeComplexity call.
 * Must be called after computeComplexity for the same file. Returns null if not cached.
 */
export function computeComplexitySync(file: string): ComplexityResult | null {
	if (_lastFile === file && _lastResult) return _lastResult;
	return null;
}

/** Cache a result for sync access. Called internally after async computation. */
export function cacheComplexityResult(file: string, result: ComplexityResult | null): void {
	_lastFile = file;
	_lastResult = result;
}

// ── Internal: find functions and compute complexity ──

function findFunctions(
	node: TSNode,
	langNodes: LanguageNodes,
	results: FunctionComplexity[],
): void {
	if (langNodes.functionTypes.includes(node.type)) {
		const name = extractFuncName(node) ?? "<anonymous>";
		const line = node.startPosition.row + 1;
		const lineCount = node.endPosition.row - node.startPosition.row + 1;

		// Cyclomatic complexity: count decision points + 1
		let cyclomatic = 1;
		countBranches(node, langNodes, (_n) => {
			cyclomatic++;
		});

		// Cognitive complexity: count with nesting penalty
		const cognitive = computeCognitive(node, langNodes, 0);

		results.push({ name, line, cyclomatic, cognitive, lineCount });
	}

	// Recurse into children (skip nested function bodies for top-level scan)
	for (const child of node.children) {
		findFunctions(child, langNodes, results);
	}
}

function countBranches(
	node: TSNode,
	langNodes: LanguageNodes,
	onBranch: (n: TSNode) => void,
): void {
	// Count branch nodes
	if (langNodes.branchTypes.includes(node.type)) {
		onBranch(node);
	}

	// Count logical operators
	if (
		node.type === "binary_expression" ||
		node.type === "boolean_operator" ||
		node.type === "binary_operator"
	) {
		for (const child of node.children) {
			if (
				langNodes.logicalOperatorTypes.includes(child.type) ||
				langNodes.logicalOperatorTypes.includes(child.text)
			) {
				onBranch(child);
			}
		}
	}

	// Count ternary
	if (langNodes.ternaryType && node.type === langNodes.ternaryType) {
		onBranch(node);
	}

	for (const child of node.children) {
		// Don't recurse into nested functions
		if (!langNodes.functionTypes.includes(child.type)) {
			countBranches(child, langNodes, onBranch);
		}
	}
}

function computeCognitive(node: TSNode, langNodes: LanguageNodes, nestingLevel: number): number {
	let score = 0;

	for (const child of node.children) {
		// Skip nested functions
		if (langNodes.functionTypes.includes(child.type)) continue;

		// Nesting types: add 1 + nesting level
		if (langNodes.nestingTypes.includes(child.type)) {
			score += 1 + nestingLevel;
			score += computeCognitive(child, langNodes, nestingLevel + 1);
			continue;
		}

		// Logical operators (each sequence break adds 1, no nesting penalty)
		if (
			child.type === "binary_expression" ||
			child.type === "boolean_operator" ||
			child.type === "binary_operator"
		) {
			for (const grandchild of child.children) {
				if (
					langNodes.logicalOperatorTypes.includes(grandchild.type) ||
					langNodes.logicalOperatorTypes.includes(grandchild.text)
				) {
					score += 1;
				}
			}
		}

		// Ternary
		if (langNodes.ternaryType && child.type === langNodes.ternaryType) {
			score += 1 + nestingLevel;
		}

		// Recurse
		score += computeCognitive(child, langNodes, nestingLevel);
	}

	return score;
}

function extractFuncName(node: TSNode): string | null {
	// Try "name" field first
	const nameNode = node.childForFieldName("name");
	if (nameNode) return nameNode.text;

	// Arrow functions assigned to a variable: look at parent
	// This is best-effort
	return null;
}
