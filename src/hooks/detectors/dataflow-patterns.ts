/** Tree-sitter node type patterns for taint source/sink detection per language. */

export interface TaintSourcePattern {
	/** Tree-sitter node type to match (e.g., "member_expression") */
	nodeType: string;
	/** Text pattern to match on the node text */
	textPattern: RegExp;
	/** Description for PendingFix error message */
	desc: string;
}

export interface TaintSinkPattern {
	/** Tree-sitter node type to match */
	nodeType: string;
	/** Text pattern to match on the node text */
	textPattern: RegExp;
	/** Description for PendingFix error message */
	desc: string;
}

export interface TaintPattern {
	sources: TaintSourcePattern[];
	sinks: TaintSinkPattern[];
	/** Node types that create a new scope (block, function body, etc.) */
	scopeNodes: string[];
	/** Node types that define functions */
	functionNodes: string[];
	/** Node types for function parameters */
	parameterNodes: string[];
	/** Node types for variable declarations */
	variableDeclarationNodes: string[];
	/** Node types for assignments (Python, Ruby, etc.) */
	assignmentNodes: string[];
	/** Node types for call expressions */
	callNodes: string[];
}

const TS_JS_PATTERN: TaintPattern = {
	sources: [
		{ nodeType: "member_expression", textPattern: /req(?:uest)?\.body/, desc: "HTTP request body" },
		{
			nodeType: "member_expression",
			textPattern: /req(?:uest)?\.params/,
			desc: "HTTP request params",
		},
		{
			nodeType: "member_expression",
			textPattern: /req(?:uest)?\.query/,
			desc: "HTTP request query",
		},
		{
			nodeType: "member_expression",
			textPattern: /req(?:uest)?\.headers/,
			desc: "HTTP request headers",
		},
		{ nodeType: "member_expression", textPattern: /process\.argv/, desc: "process.argv" },
		{ nodeType: "member_expression", textPattern: /process\.stdin/, desc: "process.stdin" },
	],
	sinks: [
		{
			nodeType: "call_expression",
			textPattern: /\beval\s*\(/,
			desc: "eval() — code injection risk",
		},
		{
			nodeType: "call_expression",
			textPattern: /\bexec\s*\(/,
			desc: "exec() — command injection risk",
		},
		{
			nodeType: "call_expression",
			textPattern: /\bexecSync\s*\(/,
			desc: "execSync() — command injection risk",
		},
		{
			nodeType: "call_expression",
			textPattern: /\bFunction\s*\(/,
			desc: "Function() — code injection risk",
		},
		{
			nodeType: "assignment_expression",
			textPattern: /\.innerHTML\s*=/,
			desc: "innerHTML — XSS risk",
		},
		{
			nodeType: "call_expression",
			textPattern: /document\.write\s*\(/,
			desc: "document.write() — XSS risk",
		},
	],
	scopeNodes: ["statement_block", "arrow_function", "function_declaration", "method_definition"],
	functionNodes: [
		"function_declaration",
		"arrow_function",
		"method_definition",
		"function_expression",
	],
	parameterNodes: ["formal_parameters", "required_parameter", "optional_parameter"],
	variableDeclarationNodes: ["variable_declarator", "lexical_declaration"],
	assignmentNodes: ["assignment_expression"],
	callNodes: ["call_expression"],
};

const PYTHON_PATTERN: TaintPattern = {
	sources: [
		{ nodeType: "attribute", textPattern: /request\.form/, desc: "Flask request.form" },
		{ nodeType: "attribute", textPattern: /request\.args/, desc: "Flask request.args" },
		{ nodeType: "attribute", textPattern: /request\.json/, desc: "Flask request.json" },
		{ nodeType: "attribute", textPattern: /request\.data/, desc: "Flask request.data" },
		{ nodeType: "attribute", textPattern: /sys\.argv/, desc: "sys.argv" },
		{ nodeType: "call", textPattern: /\binput\s*\(/, desc: "input()" },
	],
	sinks: [
		{ nodeType: "call", textPattern: /\beval\s*\(/, desc: "eval() — code injection risk" },
		{ nodeType: "call", textPattern: /\bexec\s*\(/, desc: "exec() — code injection risk" },
		{
			nodeType: "call",
			textPattern: /os\.system\s*\(/,
			desc: "os.system() — command injection risk",
		},
		{
			nodeType: "call",
			textPattern: /subprocess\.(?:call|run|Popen)\s*\(/,
			desc: "subprocess — command injection risk",
		},
		{
			nodeType: "call",
			textPattern: /cursor\.execute\s*\(/,
			desc: "cursor.execute() — SQL injection risk",
		},
	],
	scopeNodes: ["block", "function_definition", "class_definition"],
	functionNodes: ["function_definition"],
	parameterNodes: ["parameters", "default_parameter", "typed_parameter"],
	variableDeclarationNodes: [],
	assignmentNodes: ["assignment", "augmented_assignment"],
	callNodes: ["call"],
};

const GO_PATTERN: TaintPattern = {
	sources: [
		{ nodeType: "call_expression", textPattern: /\.FormValue\s*\(/, desc: "HTTP FormValue" },
		{ nodeType: "selector_expression", textPattern: /\.URL\.Query/, desc: "URL.Query" },
		{ nodeType: "selector_expression", textPattern: /os\.Args/, desc: "os.Args" },
	],
	sinks: [
		{
			nodeType: "call_expression",
			textPattern: /exec\.Command\s*\(/,
			desc: "exec.Command() — command injection risk",
		},
		{
			nodeType: "call_expression",
			textPattern: /template\.HTML\s*\(/,
			desc: "template.HTML() — XSS risk",
		},
		{
			nodeType: "call_expression",
			textPattern: /db\.(?:Exec|Query)\s*\(/,
			desc: "db.Exec/Query() — SQL injection risk",
		},
	],
	scopeNodes: ["block", "function_declaration", "method_declaration"],
	functionNodes: ["function_declaration", "method_declaration", "func_literal"],
	parameterNodes: ["parameter_list", "parameter_declaration"],
	variableDeclarationNodes: ["short_var_declaration", "var_declaration"],
	assignmentNodes: ["assignment_statement"],
	callNodes: ["call_expression"],
};

const RUST_PATTERN: TaintPattern = {
	sources: [
		{ nodeType: "call_expression", textPattern: /std::io::stdin/, desc: "stdin" },
		{ nodeType: "call_expression", textPattern: /env::args/, desc: "env::args" },
	],
	sinks: [
		{ nodeType: "macro_invocation", textPattern: /format!/, desc: "format! with user input" },
	],
	scopeNodes: ["block", "function_item", "impl_item"],
	functionNodes: ["function_item"],
	parameterNodes: ["parameters", "parameter"],
	variableDeclarationNodes: ["let_declaration"],
	assignmentNodes: ["assignment_expression"],
	callNodes: ["call_expression", "macro_invocation"],
};

const RUBY_PATTERN: TaintPattern = {
	sources: [
		{ nodeType: "element_reference", textPattern: /params\[/, desc: "params[] — user input" },
		{ nodeType: "call", textPattern: /request\.env/, desc: "request.env" },
		{ nodeType: "call", textPattern: /\bgets\b/, desc: "gets — stdin" },
	],
	sinks: [
		{ nodeType: "call", textPattern: /\bsystem\s*\(/, desc: "system() — command injection risk" },
		{ nodeType: "call", textPattern: /\beval\s*\(/, desc: "eval() — code injection risk" },
		{ nodeType: "call", textPattern: /\bexec\s*\(/, desc: "exec() — command injection risk" },
		{ nodeType: "subshell", textPattern: /`/, desc: "backtick command — command injection risk" },
	],
	scopeNodes: ["body_statement", "method", "do_block", "block"],
	functionNodes: ["method", "singleton_method"],
	parameterNodes: ["method_parameters", "block_parameters"],
	variableDeclarationNodes: [],
	assignmentNodes: ["assignment"],
	callNodes: ["call", "method_call"],
};

const JAVA_PATTERN: TaintPattern = {
	sources: [
		{
			nodeType: "method_invocation",
			textPattern: /\.getParameter\s*\(/,
			desc: "request.getParameter",
		},
		{
			nodeType: "method_invocation",
			textPattern: /\.getInputStream\s*\(/,
			desc: "request.getInputStream",
		},
		{ nodeType: "method_invocation", textPattern: /\.getHeader\s*\(/, desc: "request.getHeader" },
	],
	sinks: [
		{
			nodeType: "method_invocation",
			textPattern: /Runtime.*\.exec\s*\(/,
			desc: "Runtime.exec() — command injection",
		},
		{
			nodeType: "object_creation_expression",
			textPattern: /new\s+ProcessBuilder/,
			desc: "ProcessBuilder — command injection",
		},
		{
			nodeType: "method_invocation",
			textPattern: /\.execute\s*\(/,
			desc: "Statement.execute() — SQL injection",
		},
		{
			nodeType: "method_invocation",
			textPattern: /\.executeQuery\s*\(/,
			desc: "executeQuery() — SQL injection",
		},
	],
	scopeNodes: ["block", "method_declaration", "constructor_declaration"],
	functionNodes: ["method_declaration", "constructor_declaration"],
	parameterNodes: ["formal_parameters", "formal_parameter"],
	variableDeclarationNodes: ["local_variable_declaration"],
	assignmentNodes: ["assignment_expression"],
	callNodes: ["method_invocation"],
};

/** Get taint patterns for a language. */
export function getPatternsForLanguage(lang: string): TaintPattern | null {
	switch (lang) {
		case "typescript":
		case "tsx":
			return TS_JS_PATTERN;
		case "python":
			return PYTHON_PATTERN;
		case "go":
			return GO_PATTERN;
		case "rust":
			return RUST_PATTERN;
		case "ruby":
			return RUBY_PATTERN;
		case "java":
			return JAVA_PATTERN;
		default:
			return null;
	}
}
