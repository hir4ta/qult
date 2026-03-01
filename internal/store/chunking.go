package store

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

// CodeChunk represents a semantically meaningful piece of code extracted by AST parsing.
type CodeChunk struct {
	FilePath  string // relative file path
	Symbol    string // function/type name
	Kind      string // "func", "type", "method", "const", "var"
	StartLine int
	EndLine   int
	Content   string // source code
	EmbedText string // text for embedding (prefix + signature)
}

// ChunkGoFile parses a Go file and splits it into function/type chunks.
// Each chunk includes metadata for embedding and retrieval.
func ChunkGoFile(filePath string) ([]CodeChunk, error) {
	src, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", filePath, err)
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filePath, src, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", filePath, err)
	}

	lines := strings.Split(string(src), "\n")
	var chunks []CodeChunk

	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Body == nil {
				continue
			}
			start := fset.Position(d.Pos()).Line
			end := fset.Position(d.End()).Line
			content := extractLines(lines, start, end)

			kind := "func"
			symbol := d.Name.Name
			if d.Recv != nil {
				kind = "method"
				if len(d.Recv.List) > 0 {
					symbol = formatReceiver(d.Recv.List[0].Type) + "." + symbol
				}
			}

			embedText := fmt.Sprintf("Go %s %s in %s", kind, symbol, filepath.Base(filePath))
			chunks = append(chunks, CodeChunk{
				FilePath:  filePath,
				Symbol:    symbol,
				Kind:      kind,
				StartLine: start,
				EndLine:   end,
				Content:   content,
				EmbedText: embedText,
			})

		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					start := fset.Position(d.Pos()).Line
					end := fset.Position(d.End()).Line
					content := extractLines(lines, start, end)

					embedText := fmt.Sprintf("Go type %s in %s", s.Name.Name, filepath.Base(filePath))
					chunks = append(chunks, CodeChunk{
						FilePath:  filePath,
						Symbol:    s.Name.Name,
						Kind:      "type",
						StartLine: start,
						EndLine:   end,
						Content:   content,
						EmbedText: embedText,
					})
				}
			}
		}
	}

	return chunks, nil
}

// extractLines returns lines[start-1:end] joined with newlines.
func extractLines(lines []string, start, end int) string {
	if start < 1 {
		start = 1
	}
	if end > len(lines) {
		end = len(lines)
	}
	return strings.Join(lines[start-1:end], "\n")
}

// formatReceiver formats an AST receiver type expression as a string.
func formatReceiver(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.StarExpr:
		if ident, ok := t.X.(*ast.Ident); ok {
			return ident.Name
		}
	case *ast.Ident:
		return t.Name
	}
	return ""
}

