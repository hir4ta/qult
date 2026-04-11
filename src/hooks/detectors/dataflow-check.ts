import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { isGateDisabled } from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";
import { sanitizeForStderr } from "../sanitize.ts";
import { getPatternsForLanguage } from "./dataflow-patterns.ts";
import { extToLanguage, initParser, type SupportedLanguage } from "./tree-sitter-init.ts";

const MAX_CHECK_SIZE = 500_000;
const MAX_HOPS = 3;

interface TaintedVar {
	name: string;
	/** Scope depth where this variable was tainted */
	scopeDepth: number;
	/** Hop count from original source */
	hop: number;
	/** Description of original taint source */
	sourceDesc: string;
}

/**
 * Detect dataflow injection issues using Tree-sitter AST analysis.
 * Tracks tainted variables from user input sources to dangerous sinks.
 * Returns PendingFix[] (fail-open: empty array on any error).
 */
export async function detectDataflowIssues(file: string): Promise<PendingFix[]> {
	if (isGateDisabled("dataflow-check")) return [];

	try {
		const ext = extname(file).toLowerCase();
		const lang = extToLanguage(ext);
		if (!lang) return [];
		if (!existsSync(file)) return [];

		const content = readFileSync(file, "utf-8");
		if (content.length > MAX_CHECK_SIZE) return [];

		const patterns = getPatternsForLanguage(lang);
		if (!patterns) return [];

		const result = await initParser(lang);
		if (!result) return [];

		const tree = result.parse(content);
		if (!tree) return [];

		const errors: string[] = [];
		const rootNode = (tree as { rootNode: TreeSitterNode }).rootNode;

		// Phase 1: Collect tainted variables and function definitions
		const globalTainted = new Map<string, TaintedVar>();
		const functionDefs = new Map<string, { params: string[]; bodyNode: TreeSitterNode }>();

		collectTaintsAndFunctions(rootNode, patterns, lang, globalTainted, functionDefs, 0, content);

		// Phase 2: Propagate taint through assignments (multi-hop)
		for (let hop = 1; hop <= MAX_HOPS; hop++) {
			propagateTaint(rootNode, globalTainted, patterns, hop, content);
		}

		// Phase 3: Propagate through function calls
		propagateThroughCalls(rootNode, globalTainted, functionDefs, patterns, content);

		// Phase 4: Check sinks for tainted arguments
		checkSinks(rootNode, globalTainted, patterns, errors, content);

		if (errors.length === 0) return [];

		return [
			{
				file,
				errors: errors.map((e) => sanitizeForStderr(e.slice(0, 300))),
				gate: "dataflow-check",
			},
		];
	} catch {
		return []; // fail-open
	}
}

// ── Internal types ──────────────────────────────────────────

interface TreeSitterNode {
	type: string;
	text: string;
	startPosition: { row: number; column: number };
	childCount: number;
	children: TreeSitterNode[];
	child(index: number): TreeSitterNode | null;
	namedChildren: TreeSitterNode[];
	namedChild(index: number): TreeSitterNode | null;
	childForFieldName(name: string): TreeSitterNode | null;
}

// ── Phase 1: Collect initial taint sources and function defs ──

function collectTaintsAndFunctions(
	node: TreeSitterNode,
	patterns: ReturnType<typeof getPatternsForLanguage>,
	lang: SupportedLanguage,
	tainted: Map<string, TaintedVar>,
	functions: Map<string, { params: string[]; bodyNode: TreeSitterNode }>,
	scopeDepth: number,
	source: string,
): void {
	if (!patterns) return;

	// Check if this node is a variable declaration with a taint source
	if (isVariableDeclaration(node, patterns, lang)) {
		const varName = extractVarName(node, lang);
		const initializer = extractInitializer(node, lang);
		if (varName && initializer) {
			for (const src of patterns.sources) {
				if (src.textPattern.test(initializer.text)) {
					tainted.set(varName, { name: varName, scopeDepth, hop: 0, sourceDesc: src.desc });
					break;
				}
			}
		}
	}

	// Collect function definitions
	if (patterns.functionNodes.includes(node.type)) {
		const funcName = extractFunctionName(node, lang);
		if (funcName) {
			const params = extractParams(node, lang);
			const body = findBody(node, lang);
			if (body) {
				functions.set(funcName, { params, bodyNode: body });
			}
		}
	}

	// Recurse into children
	const newDepth = patterns.scopeNodes.includes(node.type) ? scopeDepth + 1 : scopeDepth;
	for (const child of node.children) {
		collectTaintsAndFunctions(child, patterns, lang, tainted, functions, newDepth, source);
	}
}

// ── Phase 2: Propagate taint through assignments ──

function propagateTaint(
	node: TreeSitterNode,
	tainted: Map<string, TaintedVar>,
	patterns: ReturnType<typeof getPatternsForLanguage>,
	hop: number,
	source: string,
): void {
	if (!patterns) return;

	// Check assignments: const b = a; where a is tainted
	const isDecl =
		node.type === "variable_declarator" ||
		patterns.assignmentNodes.includes(node.type) ||
		node.type === "assignment" ||
		node.type === "short_var_declaration";
	if (isDecl) {
		const varName = extractAssignTarget(node);
		const rhs = extractAssignSource(node);
		if (varName && rhs) {
			const rhsText = rhs.text.trim();
			const tv = tainted.get(rhsText);
			if (tv) {
				const newHop = tv.hop + 1;
				if (newHop <= MAX_HOPS) {
					const existing = tainted.get(varName);
					// Only set if not already tainted at a lower hop count
					if (!existing || existing.hop > newHop) {
						tainted.set(varName, {
							name: varName,
							scopeDepth: 0,
							hop: newHop,
							sourceDesc: tv.sourceDesc,
						});
					}
				}
			}
		}
	}

	for (const child of node.children) {
		propagateTaint(child, tainted, patterns, hop, source);
	}
}

// ── Phase 3: Propagate through function calls ──

function propagateThroughCalls(
	node: TreeSitterNode,
	tainted: Map<string, TaintedVar>,
	functions: Map<string, { params: string[]; bodyNode: TreeSitterNode }>,
	patterns: ReturnType<typeof getPatternsForLanguage>,
	source: string,
): void {
	if (!patterns) return;
	if (!patterns.callNodes.includes(node.type)) {
		for (const child of node.children) {
			propagateThroughCalls(child, tainted, functions, patterns, source);
		}
		return;
	}

	// This is a call expression — check if calling a known function with tainted args
	const funcName = extractCallName(node);
	const funcDef = funcName ? functions.get(funcName) : null;
	if (funcDef) {
		const argsNode = node.childForFieldName("arguments");
		const argNodes = argsNode ? argsNode.namedChildren : [];
		for (let i = 0; i < argNodes.length && i < funcDef.params.length; i++) {
			const argNode = argNodes[i]!;
			const argText = argNode.text.trim();

			// Check if argument is a tainted variable
			const tv = tainted.get(argText);
			if (tv && tv.hop < MAX_HOPS) {
				tainted.set(funcDef.params[i]!, {
					name: funcDef.params[i]!,
					scopeDepth: 0,
					hop: tv.hop + 1,
					sourceDesc: tv.sourceDesc,
				});
				continue;
			}

			// Check if argument is a direct taint source expression (e.g., req.body)
			if (patterns) {
				for (const src of patterns.sources) {
					if (src.textPattern.test(argText)) {
						tainted.set(funcDef.params[i]!, {
							name: funcDef.params[i]!,
							scopeDepth: 0,
							hop: 1,
							sourceDesc: src.desc,
						});
						break;
					}
				}
			}
		}
	}

	for (const child of node.children) {
		propagateThroughCalls(child, tainted, functions, patterns, source);
	}
}

// ── Phase 4: Check sinks ──

function checkSinks(
	node: TreeSitterNode,
	tainted: Map<string, TaintedVar>,
	patterns: ReturnType<typeof getPatternsForLanguage>,
	errors: string[],
	source: string,
): void {
	if (!patterns) return;

	for (const sink of patterns.sinks) {
		if (node.type === sink.nodeType || patterns.callNodes.includes(node.type)) {
			if (sink.textPattern.test(node.text)) {
				// Check if any argument to this sink is tainted
				const args = extractCallArgs(node);
				for (const arg of args) {
					const tv = tainted.get(arg.trim());
					if (tv) {
						const line = node.startPosition.row + 1;
						errors.push(
							`L${line}: ${sink.desc} — tainted by ${tv.sourceDesc} (${tv.hop + 1} hop${tv.hop > 0 ? "s" : ""})`,
						);
						break;
					}
				}
			}
		}
	}

	for (const child of node.children) {
		checkSinks(child, tainted, patterns, errors, source);
	}
}

// ── Helper functions ──────────────────────────────────────────

function isVariableDeclaration(
	node: TreeSitterNode,
	patterns: ReturnType<typeof getPatternsForLanguage>,
	lang: SupportedLanguage,
): boolean {
	if (!patterns) return false;
	if (patterns.variableDeclarationNodes.includes(node.type)) return true;
	if (patterns.assignmentNodes.includes(node.type)) return true;
	// Python: assignment is just "x = expr"
	if (lang === "python" && node.type === "expression_statement") {
		const child = node.namedChild(0);
		if (child && child.type === "assignment") return true;
	}
	return false;
}

function extractVarName(node: TreeSitterNode, lang: SupportedLanguage): string | null {
	// JS/TS: variable_declarator → name field
	if (node.type === "variable_declarator") {
		const nameNode = node.childForFieldName("name");
		return nameNode?.text ?? null;
	}
	// Lexical declaration → first declarator
	if (node.type === "lexical_declaration") {
		const declarator = node.namedChildren.find((c) => c.type === "variable_declarator");
		if (declarator) return extractVarName(declarator, lang);
	}
	// Python: assignment → left side
	if (node.type === "assignment" || node.type === "expression_statement") {
		const assignment = node.type === "assignment" ? node : node.namedChild(0);
		if (assignment?.type === "assignment") {
			const left = assignment.childForFieldName("left");
			return left?.text ?? null;
		}
	}
	// Go: short_var_declaration
	if (node.type === "short_var_declaration") {
		const left = node.childForFieldName("left");
		return left?.text ?? null;
	}
	return null;
}

function extractInitializer(node: TreeSitterNode, lang: SupportedLanguage): TreeSitterNode | null {
	if (node.type === "variable_declarator") {
		return node.childForFieldName("value");
	}
	if (node.type === "lexical_declaration") {
		const declarator = node.namedChildren.find((c) => c.type === "variable_declarator");
		if (declarator) return extractInitializer(declarator, lang);
	}
	if (node.type === "assignment" || node.type === "expression_statement") {
		const assignment = node.type === "assignment" ? node : node.namedChild(0);
		if (assignment?.type === "assignment") {
			return assignment.childForFieldName("right");
		}
	}
	if (node.type === "short_var_declaration") {
		return node.childForFieldName("right");
	}
	return null;
}

function extractAssignTarget(node: TreeSitterNode): string | null {
	if (node.type === "variable_declarator") {
		return node.childForFieldName("name")?.text ?? null;
	}
	if (node.type === "lexical_declaration") {
		const declarator = node.namedChildren.find((c) => c.type === "variable_declarator");
		return declarator ? extractAssignTarget(declarator) : null;
	}
	if (
		node.type === "assignment" ||
		node.type === "assignment_expression" ||
		node.type === "assignment_statement"
	) {
		return node.childForFieldName("left")?.text ?? null;
	}
	if (node.type === "short_var_declaration") {
		return node.childForFieldName("left")?.text ?? null;
	}
	return null;
}

function extractAssignSource(node: TreeSitterNode): TreeSitterNode | null {
	if (node.type === "variable_declarator") {
		return node.childForFieldName("value");
	}
	if (node.type === "lexical_declaration") {
		const declarator = node.namedChildren.find((c) => c.type === "variable_declarator");
		return declarator ? extractAssignSource(declarator) : null;
	}
	if (
		node.type === "assignment" ||
		node.type === "assignment_expression" ||
		node.type === "assignment_statement"
	) {
		return node.childForFieldName("right");
	}
	if (node.type === "short_var_declaration") {
		return node.childForFieldName("right");
	}
	return null;
}

function extractFunctionName(node: TreeSitterNode, _lang: SupportedLanguage): string | null {
	const nameNode = node.childForFieldName("name");
	return nameNode?.text ?? null;
}

function extractParams(node: TreeSitterNode, _lang: SupportedLanguage): string[] {
	const paramsNode = node.childForFieldName("parameters");
	if (!paramsNode) return [];
	return paramsNode.namedChildren
		.map((p) => {
			// Get the parameter name (first identifier child or "name" field)
			const nameField = p.childForFieldName("name") ?? p.childForFieldName("pattern");
			if (nameField) return nameField.text;
			if (p.type === "identifier") return p.text;
			// For simple params, the text itself might be the name
			const firstIdent = p.namedChildren.find((c) => c.type === "identifier");
			return firstIdent?.text ?? p.text;
		})
		.filter((name) => name.length > 0);
}

function findBody(node: TreeSitterNode, _lang: SupportedLanguage): TreeSitterNode | null {
	return node.childForFieldName("body");
}

function extractCallName(node: TreeSitterNode): string | null {
	const funcNode = node.childForFieldName("function");
	if (funcNode?.type === "identifier") return funcNode.text;
	return null;
}

function extractCallArgs(node: TreeSitterNode): string[] {
	const argsNode = node.childForFieldName("arguments");
	if (!argsNode) {
		// Fallback: look for argument_list or similar
		const argList = node.namedChildren.find(
			(c) => c.type === "arguments" || c.type === "argument_list",
		);
		if (argList) {
			return argList.namedChildren.map((c) => c.text);
		}
		return [];
	}
	return argsNode.namedChildren.map((c) => c.text);
}
