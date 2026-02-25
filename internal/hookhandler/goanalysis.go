package hookhandler

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
)

// GoASTCheck performs lightweight AST-based analysis on Go code.
// Returns the first issue found, or "" if clean. Designed for hook
// timeouts: single file parse (<50ms) + walk (<50ms).
func GoASTCheck(filePath, content string) string {
	if strings.HasSuffix(filePath, "_test.go") {
		return ""
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filePath, content, parser.ParseComments)
	if err != nil {
		return "" // unparseable snippet — fall back to regex checks
	}

	// Run checks in priority order, return first hit.
	if issue := checkErrorShadow(fset, file); issue != "" {
		return issue
	}
	if issue := checkCyclomaticComplexity(fset, file); issue != "" {
		return issue
	}
	if issue := checkGoroutineContext(fset, file); issue != "" {
		return issue
	}
	if issue := checkDeferInLoop(fset, file); issue != "" {
		return issue
	}
	return ""
}

// checkErrorShadow detects re-declaration of `err` with := inside an
// `if err != nil` block, which shadows the outer error variable.
func checkErrorShadow(fset *token.FileSet, file *ast.File) string {
	var issue string
	ast.Inspect(file, func(n ast.Node) bool {
		if issue != "" {
			return false
		}
		ifStmt, ok := n.(*ast.IfStmt)
		if !ok {
			return true
		}
		// Check if this is `if err != nil`.
		if !isErrNilCheck(ifStmt.Cond) {
			return true
		}
		// Walk the if body for `:=` assignments that include `err`.
		ast.Inspect(ifStmt.Body, func(inner ast.Node) bool {
			if issue != "" {
				return false
			}
			assign, ok := inner.(*ast.AssignStmt)
			if !ok || assign.Tok != token.DEFINE {
				return true
			}
			for _, lhs := range assign.Lhs {
				ident, ok := lhs.(*ast.Ident)
				if ok && ident.Name == "err" {
					pos := fset.Position(assign.Pos())
					issue = fmt.Sprintf("Error variable shadowed with `:=` inside `if err != nil` block (line %d)", pos.Line)
					return false
				}
			}
			return true
		})
		return true
	})
	return issue
}

// isErrNilCheck returns true if the expression is `err != nil` or `nil != err`.
func isErrNilCheck(expr ast.Expr) bool {
	bin, ok := expr.(*ast.BinaryExpr)
	if !ok || bin.Op != token.NEQ {
		return false
	}
	lIdent, lOk := bin.X.(*ast.Ident)
	rIdent, rOk := bin.Y.(*ast.Ident)
	if lOk && lIdent.Name == "err" && rOk && rIdent.Name == "nil" {
		return true
	}
	if lOk && lIdent.Name == "nil" && rOk && rIdent.Name == "err" {
		return true
	}
	return false
}

// checkCyclomaticComplexity counts decision points in each function.
// Warns if complexity exceeds the threshold (15).
func checkCyclomaticComplexity(fset *token.FileSet, file *ast.File) string {
	const threshold = 15
	var issue string

	for _, decl := range file.Decls {
		funcDecl, ok := decl.(*ast.FuncDecl)
		if !ok || funcDecl.Body == nil {
			continue
		}

		complexity := 1 // base complexity
		ast.Inspect(funcDecl.Body, func(n ast.Node) bool {
			switch v := n.(type) {
			case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt,
				*ast.CaseClause, *ast.CommClause:
				_ = v
				complexity++
			case *ast.BinaryExpr:
				if v.Op == token.LAND || v.Op == token.LOR {
					complexity++
				}
			}
			return true
		})

		if complexity > threshold {
			pos := fset.Position(funcDecl.Pos())
			issue = fmt.Sprintf("Function %s has cyclomatic complexity %d (threshold: %d) at line %d — consider splitting",
				funcDecl.Name.Name, complexity, threshold, pos.Line)
			return issue
		}
	}
	return issue
}

// checkGoroutineContext detects `go func()` closures that don't capture
// context.Context or use a done/cancel/WaitGroup pattern.
func checkGoroutineContext(fset *token.FileSet, file *ast.File) string {
	var issue string
	ast.Inspect(file, func(n ast.Node) bool {
		if issue != "" {
			return false
		}
		goStmt, ok := n.(*ast.GoStmt)
		if !ok {
			return true
		}
		funcLit, ok := goStmt.Call.Fun.(*ast.FuncLit)
		if !ok {
			return true
		}

		// Check if the goroutine body references lifecycle patterns.
		hasLifecycle := false
		ast.Inspect(funcLit.Body, func(inner ast.Node) bool {
			if hasLifecycle {
				return false
			}
			ident, ok := inner.(*ast.Ident)
			if !ok {
				return true
			}
			switch ident.Name {
			case "ctx", "done", "cancel", "wg", "errg":
				hasLifecycle = true
				return false
			}
			return true
		})

		// Also check function parameters.
		if funcLit.Type.Params != nil {
			for _, param := range funcLit.Type.Params.List {
				if sel, ok := param.Type.(*ast.SelectorExpr); ok {
					if ident, ok := sel.X.(*ast.Ident); ok && ident.Name == "context" {
						hasLifecycle = true
					}
				}
			}
		}

		// Check arguments passed to the goroutine.
		for _, arg := range goStmt.Call.Args {
			if ident, ok := arg.(*ast.Ident); ok {
				switch ident.Name {
				case "ctx", "done", "cancel":
					hasLifecycle = true
				}
			}
		}

		if !hasLifecycle {
			pos := fset.Position(goStmt.Pos())
			issue = fmt.Sprintf("`go func()` without context/done/WaitGroup at line %d — goroutine may leak", pos.Line)
		}
		return true
	})
	return issue
}

// checkDeferInLoop detects defer statements inside for/range loops.
func checkDeferInLoop(fset *token.FileSet, file *ast.File) string {
	var issue string
	var inLoop bool

	ast.Inspect(file, func(n ast.Node) bool {
		if issue != "" {
			return false
		}
		switch n.(type) {
		case *ast.ForStmt, *ast.RangeStmt:
			// Track loop entry; inspect body separately.
			loopNode := n
			var body *ast.BlockStmt
			if f, ok := loopNode.(*ast.ForStmt); ok {
				body = f.Body
			} else if r, ok := loopNode.(*ast.RangeStmt); ok {
				body = r.Body
			}
			if body == nil {
				return true
			}
			oldInLoop := inLoop
			inLoop = true
			ast.Inspect(body, func(inner ast.Node) bool {
				if issue != "" {
					return false
				}
				if deferStmt, ok := inner.(*ast.DeferStmt); ok && inLoop {
					pos := fset.Position(deferStmt.Pos())
					issue = fmt.Sprintf("`defer` inside loop at line %d — deferred calls accumulate until function returns", pos.Line)
					return false
				}
				return true
			})
			inLoop = oldInLoop
			return false // already inspected body
		}
		return true
	})
	return issue
}
