package hookhandler

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/odvcencio/gotreesitter"
	"github.com/odvcencio/gotreesitter/grammars"
)

// tsAnalyzer uses gotreesitter (pure Go tree-sitter) for AST-based analysis
// of Python, JavaScript, TypeScript, and Rust files.
type tsAnalyzer struct {
	mu      sync.Mutex
	parsers map[string]*gotreesitter.Parser
	langs   map[string]*gotreesitter.Language
}

// NewTreeSitterAnalyzer creates a CodeAnalyzer backed by gotreesitter.
func NewTreeSitterAnalyzer() CodeAnalyzer {
	return &tsAnalyzer{
		parsers: make(map[string]*gotreesitter.Parser),
		langs:   make(map[string]*gotreesitter.Language),
	}
}

func (t *tsAnalyzer) getParser(ext string) (*gotreesitter.Parser, *gotreesitter.Language) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if p, ok := t.parsers[ext]; ok {
		return p, t.langs[ext]
	}

	entry := grammars.DetectLanguage("x." + ext)
	if entry == nil {
		return nil, nil
	}
	lang := entry.Language()
	if lang == nil {
		return nil, nil
	}
	p := gotreesitter.NewParser(lang)
	t.parsers[ext] = p
	t.langs[ext] = lang
	return p, lang
}

func (t *tsAnalyzer) Analyze(filePath string, content []byte) []Finding {
	ext := rawFileExt(filePath)
	parser, lang := t.getParser(ext)
	if parser == nil {
		return nil
	}

	tree, err := parser.Parse(content)
	if err != nil || tree == nil {
		return nil
	}
	defer tree.Release()

	root := tree.RootNode()
	if root == nil {
		return nil
	}

	var findings []Finding
	switch ext {
	case "py":
		findings = analyzePython(filePath, content, root, lang)
	case "js", "mjs", "cjs", "jsx":
		findings = analyzeJS(filePath, content, root, lang, false)
	case "ts", "tsx":
		findings = analyzeJS(filePath, content, root, lang, true)
	case "rs":
		findings = analyzeRust(filePath, content, root, lang)
	}

	// Cognitive complexity via AST node counting.
	if cc := astCognitiveComplexity(root, lang); cc > 15 {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "info",
			Rule:     "complexity",
			Message:  fmt.Sprintf("Estimated cognitive complexity: %d (high) — consider breaking into smaller functions", cc),
			Category: "complexity",
		})
	}

	return findings
}

func (t *tsAnalyzer) SupportedLanguages() []string {
	return []string{"py", "js", "ts", "tsx", "jsx", "rs"}
}

// rawFileExt returns the real file extension without normalization.
func rawFileExt(path string) string {
	ext := filepath.Ext(path)
	if ext == "" {
		return ""
	}
	return ext[1:]
}

// --- Tree-sitter helpers ---

// namedChildByType returns the first named child with the given type.
func namedChildByType(n *gotreesitter.Node, lang *gotreesitter.Language, nodeType string) *gotreesitter.Node {
	for i := 0; i < n.ChildCount(); i++ {
		child := n.Child(i)
		if child.IsNamed() && child.Type(lang) == nodeType {
			return child
		}
	}
	return nil
}


// --- Python analysis ---

func analyzePython(filePath string, src []byte, root *gotreesitter.Node, lang *gotreesitter.Language) []Finding {
	isTest := strings.Contains(filePath, "test")
	var findings []Finding

	gotreesitter.Walk(root, func(n *gotreesitter.Node, depth int) gotreesitter.WalkAction {
		nodeType := n.Type(lang)

		switch nodeType {
		case "except_clause":
			if isPyBareExcept(n, lang) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "warning",
					Rule:     "py-bare-except",
					Message:  "Bare `except:` catches all exceptions including KeyboardInterrupt — specify the exception type",
					Category: "error_handling",
				})
			} else if isPyBroadExcept(n, lang, src) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "info",
					Rule:     "py-broad-exception",
					Message:  "`except Exception` is very broad — consider catching specific exception types",
					Category: "error_handling",
				})
			}

		case "default_parameter":
			// Find the value child by looking for list/dictionary among named children.
			if valType := pyMutableDefaultType(n, lang); valType != "" {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "warning",
					Rule:     "py-mutable-default",
					Message:  fmt.Sprintf("Mutable default argument `%s` — use `None` and assign inside the function body", valType),
					Category: "style",
				})
			}

		case "wildcard_import":
			findings = append(findings, Finding{
				File:     filePath,
				Line:     int(n.StartPoint().Row) + 1,
				Severity: "warning",
				Rule:     "py-star-import",
				Message:  "`from module import *` pollutes namespace — import specific names",
				Category: "style",
			})

		case "assert_statement":
			if !isTest {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "info",
					Rule:     "py-assert-in-prod",
					Message:  "`assert` in non-test code — stripped with `python -O`, use explicit checks",
					Category: "error_handling",
				})
			}

		case "call":
			if !isTest && isPyDangerousCall(n, lang, src) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "warning",
					Rule:     "py-eval-exec",
					Message:  "`eval()`/`exec()` detected — potential code injection risk, use `ast.literal_eval()` or safer alternatives",
					Category: "security",
				})
			}
			if !isTest && isPyPrintCall(n, lang, src) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "info",
					Rule:     "py-print-debug",
					Message:  "`print()` in non-test code — use `logging` module for production output",
					Category: "style",
				})
			}
		}

		// Python bare except fallback: the gotreesitter Python grammar sometimes
		// absorbs bare except into the block node as anonymous children.
		// Detect "except" keyword followed by ":" with no named child between them.
		if nodeType == "try_statement" || nodeType == "block" {
			if bareExceptLine := detectBareExceptInChildren(n, lang, src); bareExceptLine > 0 {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     bareExceptLine,
					Severity: "warning",
					Rule:     "py-bare-except",
					Message:  "Bare `except:` catches all exceptions including KeyboardInterrupt — specify the exception type",
					Category: "error_handling",
				})
			}
		}

		return gotreesitter.WalkContinue
	})

	return findings
}

// detectBareExceptInChildren scans a node's children for the pattern:
// anonymous "except" followed immediately by anonymous ":" with no type child.
func detectBareExceptInChildren(n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) int {
	count := n.ChildCount()
	for i := 0; i < count; i++ {
		child := n.Child(i)
		if !child.IsNamed() && child.Text(src) == "except" {
			// Check next sibling: if it's ":", this is a bare except.
			if i+1 < count {
				next := n.Child(i + 1)
				if !next.IsNamed() && next.Text(src) == ":" {
					return int(child.StartPoint().Row) + 1
				}
			}
		}
	}
	return 0
}

// isPyBareExcept checks if an except_clause has no exception type.
func isPyBareExcept(n *gotreesitter.Node, lang *gotreesitter.Language) bool {
	for i := 0; i < n.ChildCount(); i++ {
		child := n.Child(i)
		ct := child.Type(lang)
		if ct == "identifier" || ct == "attribute" || ct == "tuple" || ct == "as_pattern" {
			return false
		}
	}
	return true
}

// isPyBroadExcept checks if an except_clause catches "Exception".
func isPyBroadExcept(n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) bool {
	for i := 0; i < n.ChildCount(); i++ {
		child := n.Child(i)
		if child.Type(lang) == "identifier" && child.Text(src) == "Exception" {
			return true
		}
	}
	return false
}

// pyMutableDefaultType returns "[]" or "{}" if the default_parameter has a mutable default.
func pyMutableDefaultType(n *gotreesitter.Node, lang *gotreesitter.Language) string {
	// The value is typically the last named child after "=".
	for i := 0; i < n.ChildCount(); i++ {
		child := n.Child(i)
		if !child.IsNamed() {
			continue
		}
		ct := child.Type(lang)
		if ct == "list" {
			return "[]"
		}
		if ct == "dictionary" {
			return "{}"
		}
	}
	return ""
}

// isPyDangerousCall checks if a call node invokes eval() or exec().
func isPyDangerousCall(n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) bool {
	fn := namedChildByType(n, lang, "identifier")
	if fn == nil {
		return false
	}
	name := fn.Text(src)
	return name == "eval" || name == "exec"
}

// isPyPrintCall checks if a call node invokes print().
func isPyPrintCall(n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) bool {
	fn := namedChildByType(n, lang, "identifier")
	if fn == nil {
		return false
	}
	return fn.Text(src) == "print"
}

// --- JavaScript/TypeScript analysis ---

func analyzeJS(filePath string, src []byte, root *gotreesitter.Node, lang *gotreesitter.Language, isTS bool) []Finding {
	base := filepath.Base(filePath)
	isTest := strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") || strings.Contains(base, "_test.")
	var findings []Finding

	gotreesitter.Walk(root, func(n *gotreesitter.Node, depth int) gotreesitter.WalkAction {
		nodeType := n.Type(lang)

		switch nodeType {
		case "call_expression":
			if !isTest && jsIsConsoleLog(n, lang, src) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "warning",
					Rule:     "js-console-log",
					Message:  "console.log detected — remove debug logs before committing",
					Category: "style",
				})
			}

		case "binary_expression":
			if !isTest && jsIsLooseEquality(n, lang, src) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "warning",
					Rule:     "js-loose-equality",
					Message:  "`==` used instead of `===` — prefer strict equality to avoid type coercion",
					Category: "style",
				})
			}

		case "import_statement":
			findings = append(findings, jsCheckUnusedImports(filePath, n, lang, src)...)

		case "function_declaration", "function_expression", "arrow_function",
			"method_definition":
			if jsIsAsyncWithoutAwait(n, lang, src) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "warning",
					Rule:     "js-async-no-await",
					Message:  "`async` function without `await` — remove `async` or add awaited calls",
					Category: "error_handling",
				})
			}
			return gotreesitter.WalkSkipChildren

		case "type_annotation":
			if isTS && tsContainsAnyType(n, lang, src) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "info",
					Rule:     "ts-any-type",
					Message:  "`any` type weakens type safety — use `unknown` or a specific type",
					Category: "style",
				})
			}

		case "as_expression":
			if isTS && tsIsAsAny(n, lang, src) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "warning",
					Rule:     "ts-as-any",
					Message:  "`as any` bypasses type checking entirely — use `as unknown` or a specific type",
					Category: "style",
				})
			}
		}
		return gotreesitter.WalkContinue
	})

	return findings
}

// jsIsConsoleLog checks if a call_expression is console.log/warn/error/debug.
// Uses positional children since ChildByFieldName may not work for all grammars.
func jsIsConsoleLog(n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) bool {
	// call_expression children: member_expression, arguments
	mem := namedChildByType(n, lang, "member_expression")
	if mem == nil {
		return false
	}
	// member_expression children: identifier("console"), property_identifier("log")
	obj := namedChildByType(mem, lang, "identifier")
	prop := namedChildByType(mem, lang, "property_identifier")
	if obj == nil || prop == nil {
		return false
	}
	if obj.Text(src) != "console" {
		return false
	}
	method := prop.Text(src)
	return method == "log" || method == "warn" || method == "error" || method == "debug"
}

// jsIsLooseEquality checks if a binary_expression uses == or != (not === or !==).
func jsIsLooseEquality(n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) bool {
	for i := 0; i < n.ChildCount(); i++ {
		child := n.Child(i)
		if child.IsNamed() {
			continue
		}
		text := child.Text(src)
		if text == "==" || text == "!=" {
			// Allow == null / != null (idiomatic).
			for j := 0; j < n.ChildCount(); j++ {
				c := n.Child(j)
				if c.IsNamed() && c.Text(src) == "null" {
					return false
				}
			}
			return true
		}
	}
	return false
}

// jsIsAsyncWithoutAwait checks if a function node has async keyword but no await.
func jsIsAsyncWithoutAwait(n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) bool {
	text := n.Text(src)
	if !strings.HasPrefix(strings.TrimSpace(text), "async") {
		return false
	}

	hasAwait := false
	gotreesitter.Walk(n, func(child *gotreesitter.Node, depth int) gotreesitter.WalkAction {
		if depth == 0 {
			return gotreesitter.WalkContinue
		}
		ct := child.Type(lang)
		if ct == "await_expression" {
			hasAwait = true
			return gotreesitter.WalkStop
		}
		// Don't descend into nested functions.
		if ct == "function_declaration" || ct == "function_expression" ||
			ct == "arrow_function" || ct == "method_definition" {
			return gotreesitter.WalkSkipChildren
		}
		return gotreesitter.WalkContinue
	})
	return !hasAwait
}

// tsContainsAnyType checks if a type_annotation contains the `any` type.
func tsContainsAnyType(n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) bool {
	found := false
	gotreesitter.Walk(n, func(child *gotreesitter.Node, _ int) gotreesitter.WalkAction {
		if child.Type(lang) == "predefined_type" && child.Text(src) == "any" {
			found = true
			return gotreesitter.WalkStop
		}
		return gotreesitter.WalkContinue
	})
	return found
}

// tsIsAsAny checks if an as_expression casts to `any`.
// Matches patterns like `value as any`.
func tsIsAsAny(n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) bool {
	found := false
	gotreesitter.Walk(n, func(child *gotreesitter.Node, _ int) gotreesitter.WalkAction {
		if child.Type(lang) == "predefined_type" && child.Text(src) == "any" {
			found = true
			return gotreesitter.WalkStop
		}
		return gotreesitter.WalkContinue
	})
	return found
}

// jsCheckUnusedImports checks named imports for references in the rest of the file.
func jsCheckUnusedImports(filePath string, n *gotreesitter.Node, lang *gotreesitter.Language, src []byte) []Finding {
	var findings []Finding
	// Find import_clause → named_imports → import_specifier children.
	var names []string
	gotreesitter.Walk(n, func(child *gotreesitter.Node, _ int) gotreesitter.WalkAction {
		ct := child.Type(lang)
		if ct == "import_specifier" {
			// import_specifier may have alias: import { Foo as Bar }
			// Use the local name (alias if present, otherwise the original name).
			alias := namedChildByType(child, lang, "identifier")
			if alias != nil {
				names = append(names, alias.Text(src))
			}
		}
		return gotreesitter.WalkContinue
	})

	if len(names) == 0 {
		return nil
	}

	// Get the text after this import statement to check for usage.
	importEnd := n.EndByte()
	if int(importEnd) >= len(src) {
		return nil
	}
	rest := string(src[importEnd:])

	for _, name := range names {
		if !strings.Contains(rest, name) {
			findings = append(findings, Finding{
				File:     filePath,
				Line:     int(n.StartPoint().Row) + 1,
				Severity: "info",
				Rule:     "js-unused-import",
				Message:  "Imported `" + name + "` appears unused — remove if not needed",
				Category: "style",
			})
		}
	}
	return findings
}

// --- Rust analysis ---

func analyzeRust(filePath string, src []byte, root *gotreesitter.Node, lang *gotreesitter.Language) []Finding {
	isTest := strings.Contains(string(src), "#[cfg(test)]") || strings.HasSuffix(filePath, "_test.rs")
	var findings []Finding
	cloneCount := 0

	gotreesitter.Walk(root, func(n *gotreesitter.Node, depth int) gotreesitter.WalkAction {
		nodeType := n.Type(lang)

		switch nodeType {
		case "call_expression":
			// call_expression → field_expression → field_identifier("unwrap"/"clone")
			fe := namedChildByType(n, lang, "field_expression")
			if fe != nil {
				fi := namedChildByType(fe, lang, "field_identifier")
				if fi != nil {
					method := fi.Text(src)
					if method == "unwrap" && !isTest {
						findings = append(findings, Finding{
							File:     filePath,
							Line:     int(n.StartPoint().Row) + 1,
							Severity: "warning",
							Rule:     "rs-unwrap",
							Message:  "`.unwrap()` on Result/Option — use `?` operator or handle the error explicitly",
							Category: "error_handling",
						})
					}
					if method == "clone" && !isTest {
						cloneCount++
					}
				}
			}

		case "macro_invocation":
			id := namedChildByType(n, lang, "identifier")
			if id == nil || isTest {
				break
			}
			macroName := id.Text(src)
			if macroName == "todo" {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "warning",
					Rule:     "rs-todo-macro",
					Message:  "`todo!()` macro in non-test code — will panic at runtime",
					Category: "error_handling",
				})
			}
			if macroName == "panic" {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "warning",
					Rule:     "rs-panic-outside-test",
					Message:  "`panic!()` in non-test code — return `Result` instead, or use `unreachable!()` for impossible cases",
					Category: "error_handling",
				})
			}

		case "unsafe_block":
			if !hasSafetyComment(n, src) {
				findings = append(findings, Finding{
					File:     filePath,
					Line:     int(n.StartPoint().Row) + 1,
					Severity: "info",
					Rule:     "rs-unsafe-no-safety",
					Message:  "`unsafe` block without `// SAFETY:` comment — document the invariants",
					Category: "security",
				})
			}
		}
		return gotreesitter.WalkContinue
	})

	if cloneCount >= 5 {
		findings = append(findings, Finding{
			File:     filePath,
			Severity: "info",
			Rule:     "rs-clone-overuse",
			Message:  fmt.Sprintf("`.clone()` used %d times — consider borrowing or using references", cloneCount),
			Category: "style",
		})
	}

	return findings
}

// hasSafetyComment checks if there's a "SAFETY" comment near an unsafe block.
func hasSafetyComment(n *gotreesitter.Node, src []byte) bool {
	start := n.StartByte()
	lookback := uint32(100)
	if start < lookback {
		lookback = start
	}
	nearby := string(src[start-lookback : start])
	return strings.Contains(strings.ToUpper(nearby), "SAFETY")
}

// --- Cognitive complexity via AST ---

// controlFlowNodeTypes are node types that increment cognitive complexity.
var controlFlowNodeTypes = map[string]bool{
	"if_statement":           true,
	"elif_clause":            true,
	"else_clause":            true,
	"for_statement":          true,
	"for_in_statement":       true,
	"while_statement":        true,
	"do_statement":           true,
	"switch_statement":       true,
	"match_expression":       true,
	"try_statement":          true,
	"catch_clause":           true,
	"except_clause":          true,
	"ternary_expression":     true,
	"conditional_expression": true,
	// Rust
	"loop_expression": true,
	"match_arm":       true,
}

// functionNodeTypes identify function boundaries to reset nesting.
var functionNodeTypes = map[string]bool{
	"function_definition":  true,
	"function_declaration": true,
	"function_expression":  true,
	"arrow_function":       true,
	"method_definition":    true,
	"function_item":        true, // Rust
	"impl_item":            true, // Rust
}

// astCognitiveComplexity estimates cognitive complexity by walking the AST.
func astCognitiveComplexity(root *gotreesitter.Node, lang *gotreesitter.Language) int {
	maxComplexity := 0

	gotreesitter.Walk(root, func(n *gotreesitter.Node, depth int) gotreesitter.WalkAction {
		nodeType := n.Type(lang)
		if !functionNodeTypes[nodeType] {
			return gotreesitter.WalkContinue
		}

		cc := functionComplexity(n, lang, 0)
		if cc > maxComplexity {
			maxComplexity = cc
		}
		return gotreesitter.WalkSkipChildren
	})

	return maxComplexity
}

func functionComplexity(n *gotreesitter.Node, lang *gotreesitter.Language, nesting int) int {
	score := 0
	for i := 0; i < n.ChildCount(); i++ {
		child := n.Child(i)
		childType := child.Type(lang)

		if functionNodeTypes[childType] {
			continue // nested functions are scored independently
		}

		if controlFlowNodeTypes[childType] {
			score += 1 + nesting
			score += functionComplexity(child, lang, nesting+1)
		} else {
			score += functionComplexity(child, lang, nesting)
		}
	}
	return score
}
