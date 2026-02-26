package hookhandler

// Finding represents a single code analysis issue.
type Finding struct {
	File     string // file path
	Line     int    // line number (0 if unknown)
	Severity string // "error", "warning", "info"
	Rule     string // rule identifier
	Message  string // human-readable description
	Category string // "error_handling", "security", "complexity", "style"
}

// CodeAnalyzer is the interface for language-aware code analysis.
// Currently implemented by Go AST checks. Designed for future tree-sitter
// integration (e.g. via malivnan/tree-sitter wazero-based, CGO-free).
type CodeAnalyzer interface {
	// Analyze runs analysis on a file and returns findings.
	Analyze(filePath string, content []byte) []Finding

	// SupportedLanguages returns the languages this analyzer handles.
	SupportedLanguages() []string
}

// goAnalyzer wraps the existing GoASTCheck into the CodeAnalyzer interface.
type goAnalyzer struct{}

// NewGoAnalyzer creates a CodeAnalyzer backed by go/ast.
func NewGoAnalyzer() CodeAnalyzer {
	return &goAnalyzer{}
}

func (g *goAnalyzer) Analyze(filePath string, content []byte) []Finding {
	issue := GoASTCheck(filePath, string(content))
	if issue == "" {
		return nil
	}
	return []Finding{{
		File:     filePath,
		Severity: "warning",
		Rule:     "go-ast",
		Message:  issue,
	}}
}

func (g *goAnalyzer) SupportedLanguages() []string {
	return []string{"go"}
}
