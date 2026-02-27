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
	if issue := checkCognitiveComplexity(fset, file); issue != "" {
		return issue
	}
	if issue := checkTypeAssertionWithoutOk(fset, file); issue != "" {
		return issue
	}
	return ""
}

// checkTypeAssertionWithoutOk detects bare type assertions x.(Type) that panic
// on type mismatch instead of using the comma-ok pattern x, ok := v.(Type).
func checkTypeAssertionWithoutOk(fset *token.FileSet, file *ast.File) string {
	// First pass: collect positions of type assertions that ARE in comma-ok assignments.
	safe := make(map[token.Pos]bool)
	ast.Inspect(file, func(n ast.Node) bool {
		assign, ok := n.(*ast.AssignStmt)
		if !ok || len(assign.Lhs) < 2 {
			return true
		}
		for _, rhs := range assign.Rhs {
			if ta, ok := rhs.(*ast.TypeAssertExpr); ok {
				safe[ta.Pos()] = true
			}
		}
		return true
	})

	// Also mark type assertions in value specs with 2+ names: var v, ok = x.(T)
	ast.Inspect(file, func(n ast.Node) bool {
		vs, ok := n.(*ast.ValueSpec)
		if !ok || len(vs.Names) < 2 || len(vs.Values) == 0 {
			return true
		}
		for _, val := range vs.Values {
			if ta, ok := val.(*ast.TypeAssertExpr); ok {
				safe[ta.Pos()] = true
			}
		}
		return true
	})

	// Second pass: find type assertions NOT in the safe set.
	var issue string
	ast.Inspect(file, func(n ast.Node) bool {
		if issue != "" {
			return false
		}
		ta, ok := n.(*ast.TypeAssertExpr)
		if !ok {
			return true
		}
		// ta.Type == nil means type switch: x.(type) — skip.
		if ta.Type == nil {
			return true
		}
		if safe[ta.Pos()] {
			return true
		}
		pos := fset.Position(ta.Pos())
		issue = fmt.Sprintf("Type assertion without comma-ok at line %d — panics on mismatch, use `v, ok := x.(Type)`", pos.Line)
		return false
	})
	return issue
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

// checkCognitiveComplexity measures how hard a function is to understand.
// Unlike cyclomatic complexity, nesting depth multiplies the cost of each
// decision point. Warns if score exceeds threshold (20).
func checkCognitiveComplexity(fset *token.FileSet, file *ast.File) string {
	const threshold = 20
	for _, decl := range file.Decls {
		funcDecl, ok := decl.(*ast.FuncDecl)
		if !ok || funcDecl.Body == nil {
			continue
		}

		score := cognitiveWalk(funcDecl.Body, 0)
		if score > threshold {
			pos := fset.Position(funcDecl.Pos())
			return fmt.Sprintf("Function %s has cognitive complexity %d (threshold: %d) at line %d — deeply nested logic is hard to follow",
				funcDecl.Name.Name, score, threshold, pos.Line)
		}
	}
	return ""
}

// cognitiveWalk recursively scores a block's cognitive complexity.
// Each control structure adds 1, and nesting increments add the current depth.
func cognitiveWalk(node ast.Node, depth int) int {
	score := 0
	ast.Inspect(node, func(n ast.Node) bool {
		if n == nil {
			return false
		}
		switch v := n.(type) {
		case *ast.IfStmt:
			score += 1 + depth
			// Walk if-body at increased depth.
			score += cognitiveWalkBlock(v.Body, depth+1)
			// Handle else/else-if chain without extra nesting penalty.
			if v.Else != nil {
				if elseIf, ok := v.Else.(*ast.IfStmt); ok {
					// else-if: +1 (no nesting increment), then recurse its body.
					score++
					score += cognitiveWalkBlock(elseIf.Body, depth+1)
					// Continue the else chain if the else-if itself has an else.
					if elseIf.Else != nil {
						score += cognitiveWalkElseChain(elseIf.Else, depth)
					}
				} else if elseBlock, ok := v.Else.(*ast.BlockStmt); ok {
					// else: +1, walk at same nesting as if-body.
					score++
					score += cognitiveWalkBlock(elseBlock, depth+1)
				}
			}
			return false
		case *ast.ForStmt:
			score += 1 + depth
			score += cognitiveWalkBlock(v.Body, depth+1)
			return false
		case *ast.RangeStmt:
			score += 1 + depth
			score += cognitiveWalkBlock(v.Body, depth+1)
			return false
		case *ast.SwitchStmt:
			score += 1 + depth
			score += cognitiveWalkBlock(v.Body, depth+1)
			return false
		case *ast.TypeSwitchStmt:
			score += 1 + depth
			score += cognitiveWalkBlock(v.Body, depth+1)
			return false
		case *ast.SelectStmt:
			score += 1 + depth
			score += cognitiveWalkBlock(v.Body, depth+1)
			return false
		case *ast.BinaryExpr:
			if v.Op == token.LAND || v.Op == token.LOR {
				score++
			}
		case *ast.FuncLit:
			// Nested function literal increases depth.
			score += cognitiveWalkBlock(v.Body, depth+1)
			return false
		}
		return true
	})
	return score
}

// cognitiveWalkBlock walks the statements in a block at the given depth.
func cognitiveWalkBlock(block *ast.BlockStmt, depth int) int {
	if block == nil {
		return 0
	}
	score := 0
	for _, stmt := range block.List {
		score += cognitiveWalk(stmt, depth)
	}
	return score
}

// cognitiveWalkElseChain handles else/else-if chains after the first else-if.
// Each else-if adds +1 (no nesting increment) and its body is walked at depth+1.
func cognitiveWalkElseChain(node ast.Node, depth int) int {
	score := 0
	if elseIf, ok := node.(*ast.IfStmt); ok {
		score++
		score += cognitiveWalkBlock(elseIf.Body, depth+1)
		if elseIf.Else != nil {
			score += cognitiveWalkElseChain(elseIf.Else, depth)
		}
	} else if elseBlock, ok := node.(*ast.BlockStmt); ok {
		score++
		score += cognitiveWalkBlock(elseBlock, depth+1)
	}
	return score
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
