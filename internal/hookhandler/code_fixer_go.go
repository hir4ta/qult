package hookhandler

import (
	"go/ast"
	"go/parser"
	"go/token"
	"regexp"
	"strings"
)

// goFixer generates patches for Go code quality findings using go/ast.
type goFixer struct{}

func (g *goFixer) Fix(finding Finding, content []byte) *CodeFix {
	switch {
	case finding.Rule == "go_defer_in_loop" || strings.Contains(finding.Message, "defer` inside loop"):
		return g.fixDeferInLoop(finding, content)
	case finding.Rule == "go_nil_error_wrap" || strings.Contains(finding.Message, "wrapping nil"):
		return g.fixNilErrorWrap(finding, content)
	case finding.Rule == "go_empty_error_return" || strings.Contains(finding.Message, "swallows the error"):
		return g.fixEmptyErrorReturn(finding, content)
	case strings.Contains(finding.Message, "Error variable shadowed"):
		return g.fixErrorShadow(finding, content)
	}
	return nil
}

// fixDeferInLoop wraps a defer inside a loop with an immediately-invoked closure.
// Before: for ... { defer f.Close() }
// After:  for ... { func() { defer f.Close() }() }
func (g *goFixer) fixDeferInLoop(finding Finding, content []byte) *CodeFix {
	src := string(content)

	// Find defer statements inside for loops using AST.
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, finding.File, src, 0)
	if err != nil {
		return nil
	}

	var fix *CodeFix
	ast.Inspect(file, func(n ast.Node) bool {
		if fix != nil {
			return false
		}
		forStmt, isFor := n.(*ast.ForStmt)
		rangeStmt, isRange := n.(*ast.RangeStmt)

		var body *ast.BlockStmt
		if isFor {
			body = forStmt.Body
		} else if isRange {
			body = rangeStmt.Body
		} else {
			return true
		}
		if body == nil {
			return true
		}

		for _, stmt := range body.List {
			deferStmt, ok := stmt.(*ast.DeferStmt)
			if !ok {
				continue
			}
			start := fset.Position(deferStmt.Pos()).Offset
			end := fset.Position(deferStmt.End()).Offset
			if start < 0 || end > len(src) {
				continue
			}

			before := src[start:end]
			// Preserve the defer call, wrap in closure.
			after := "func() { " + before + " }()"

			fix = &CodeFix{
				Finding:     finding,
				Before:      before,
				After:       after,
				Confidence:  0.9,
				Explanation: "Wrap defer in closure so it executes per iteration, not at function exit",
			}
			return false
		}
		return true
	})
	return fix
}

// fixNilErrorWrap removes %w wrapping of nil errors.
// Before: fmt.Errorf("failed: %w", nil)
// After:  fmt.Errorf("failed")
var nilWrapFixPattern = regexp.MustCompile(`(fmt\.Errorf\([^)]*?):\s*%w([^)]*?),\s*nil\s*\)`)

func (g *goFixer) fixNilErrorWrap(finding Finding, content []byte) *CodeFix {
	src := string(content)
	loc := nilWrapFixPattern.FindStringIndex(src)
	if loc == nil {
		return nil
	}
	before := src[loc[0]:loc[1]]
	after := nilWrapFixPattern.ReplaceAllString(before, `${1}${2})`)

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.95,
		Explanation: "Remove %w wrapping of nil — fmt.Errorf with %w and nil creates a non-nil error containing nil",
	}
}

// fixEmptyErrorReturn changes `return nil` to `return err` inside `if err != nil`.
// Only applies when the enclosing function returns `error` as its sole return type.
// Before: if err != nil { return nil }
// After:  if err != nil { return err }
var emptyErrReturnFixPattern = regexp.MustCompile(`(if\s+err\s*!=\s*nil\s*\{\s*return\s+)nil(\s*\})`)

func (g *goFixer) fixEmptyErrorReturn(finding Finding, content []byte) *CodeFix {
	src := string(content)
	loc := emptyErrReturnFixPattern.FindStringIndex(src)
	if loc == nil {
		return nil
	}
	before := src[loc[0]:loc[1]]
	after := emptyErrReturnFixPattern.ReplaceAllString(before, `${1}err${2}`)

	// Try AST-based validation: confirm the enclosing function returns error.
	confidence := 0.65 // default for snippets where AST parsing fails
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, finding.File, src, 0)
	if err == nil {
		pos := fset.File(file.Pos()).Pos(loc[0])
		retType := enclosingFuncReturnType(file, pos)
		switch retType {
		case "error":
			confidence = 0.9
		case "":
			// Could not determine (snippet or no enclosing func)
		default:
			// Function returns non-error type (e.g., *Foo) — fix would break compilation
			return nil
		}
	}

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  confidence,
		Explanation: "Return the error instead of swallowing it — callers need to know about failures",
	}
}

// enclosingFuncReturnType finds the function containing pos and returns its
// return type as a string. Returns "" if the function has no results or
// multiple return values, and the type name for single-return functions.
func enclosingFuncReturnType(file *ast.File, pos token.Pos) string {
	var result string
	ast.Inspect(file, func(n ast.Node) bool {
		fn, ok := n.(*ast.FuncDecl)
		if !ok {
			return true
		}
		if fn.Pos() > pos || pos > fn.End() {
			return true
		}
		if fn.Type.Results == nil || len(fn.Type.Results.List) != 1 {
			return false
		}
		// Single return value — extract its type name.
		switch t := fn.Type.Results.List[0].Type.(type) {
		case *ast.Ident:
			result = t.Name
		case *ast.StarExpr:
			if id, ok := t.X.(*ast.Ident); ok {
				result = "*" + id.Name
			}
		case *ast.SelectorExpr:
			if id, ok := t.X.(*ast.Ident); ok {
				result = id.Name + "." + t.Sel.Name
			}
		}
		return false
	})
	return result
}

// fixErrorShadow changes `:=` to `=` for `err` re-declarations inside if err != nil blocks.
// Only safe when all LHS variables (except err) are already declared.
// Before: result, err := doSomething()
// After:  result, err = doSomething()
func (g *goFixer) fixErrorShadow(finding Finding, content []byte) *CodeFix {
	if finding.Line <= 0 {
		return nil
	}

	lines := strings.Split(string(content), "\n")
	if finding.Line > len(lines) {
		return nil
	}
	line := lines[finding.Line-1]

	if !strings.Contains(line, ":=") || !strings.Contains(line, "err") {
		return nil
	}

	before := strings.TrimSpace(line)
	after := strings.Replace(before, ":=", "=", 1)

	// Check if there are non-err, non-_ variables on the LHS.
	// If so, := → = may fail because those variables need declaration.
	confidence := 0.7
	lhs, _, ok := strings.Cut(before, ":=")
	if !ok {
		return nil
	}
	for _, v := range strings.Split(lhs, ",") {
		v = strings.TrimSpace(v)
		if v == "err" || v == "_" {
			continue
		}
		// New variable on LHS — changing := to = would break its declaration.
		confidence = 0.4
		break
	}

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  confidence,
		Explanation: "Use `=` instead of `:=` to avoid shadowing the outer `err` variable",
	}
}
