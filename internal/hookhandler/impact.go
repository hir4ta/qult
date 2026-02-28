package hookhandler

import (
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// ImpactInfo holds the results of an impact analysis for a file.
type ImpactInfo struct {
	Importers            []string // files that import/reference this file
	TransitiveImporterN  int      // count of transitive importers (via dep graph)
	TestFiles            []string // test files covering this file
	CoChanges            []string // files frequently changed together (from git log)
	ExportedN            int      // number of exported symbols (Go only)
	BlastScore           int      // composite risk score (0-100)
	Risk                 string   // "low", "medium", "high"
	SuggestedTestCmd     string   // specific go test -run command from coverage map
	DomainRisk           string   // domain-specific risk note (auth, database, etc.)
}

// analyzeImpact runs a lightweight impact analysis for a file being edited.
// Uses go/ast for Go files, grep-based for others. Total budget: ~1 second.
// sdb is optional; when non-nil, transitive dependency graph analysis is included.
func analyzeImpact(sdb *sessiondb.SessionDB, filePath, cwd string) *ImpactInfo {
	info := &ImpactInfo{}

	ext := filepath.Ext(filePath)
	switch ext {
	case ".go":
		analyzeGoImpact(info, filePath, cwd)
		info.ExportedN = len(GoExportedSymbols(filePath))
		// Transitive impact via dep graph (requires sdb for caching).
		if sdb != nil {
			if graph := buildGoDepGraph(sdb, cwd); graph != nil {
				pkgDir := filepath.Dir(filePath)
				relDir, _ := filepath.Rel(cwd, pkgDir)
				if modPath := goModulePath(cwd); modPath != "" && relDir != "." {
					importPath := modPath + "/" + relDir
					info.TransitiveImporterN = len(transitiveImporters(graph, importPath, 3))
				}
			}
		}
	default:
		analyzeGenericImpact(info, filePath, cwd)
	}

	findTestFiles(info, filePath, cwd)
	findCoChanges(info, filePath, cwd)

	// Coverage map: generate specific test command for Go files.
	if sdb != nil && filepath.Ext(filePath) == ".go" {
		if cm := LoadCoverageMap(sdb); cm != nil {
			info.SuggestedTestCmd = SuggestTestCommand(cm, filePath, nil, cwd)
		}
	}

	// Domain risk from file path.
	info.DomainRisk = classifyDomainRisk(filePath)

	info.BlastScore = computeBlastScore(info)
	info.Risk = assessRisk(info)
	return info
}

// goModulePath reads go.mod and returns the module path (e.g. "github.com/user/repo").
func goModulePath(cwd string) string {
	data, err := os.ReadFile(filepath.Join(cwd, "go.mod"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "module ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "module "))
		}
	}
	return ""
}

// analyzeGoImpact uses go/ast to find exported symbols, then greps for importers.
func analyzeGoImpact(info *ImpactInfo, filePath, cwd string) {
	// Parse the file to find its package name.
	fset := token.NewFileSet()
	src, err := os.ReadFile(filePath)
	if err != nil {
		return
	}
	file, err := parser.ParseFile(fset, filePath, src, parser.PackageClauseOnly)
	if err != nil {
		return
	}
	pkgName := file.Name.Name

	// Find the module-relative import path for this package.
	pkgDir := filepath.Dir(filePath)
	relDir, err := filepath.Rel(cwd, pkgDir)
	if err != nil {
		return
	}

	// Search for files importing this package within the project.
	// Use grep with a 1-second timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	// Search for the package directory name in import statements.
	searchTerm := filepath.Base(relDir)
	if searchTerm == "." || searchTerm == "" {
		searchTerm = pkgName
	}

	cmd := exec.CommandContext(ctx, "grep", "-rl", "--include=*.go",
		fmt.Sprintf(`"%s"`, searchTerm), cwd)
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return
	}

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" || line == filePath {
			continue
		}
		// Skip files in the same package directory.
		if filepath.Dir(line) == pkgDir {
			continue
		}
		rel, err := filepath.Rel(cwd, line)
		if err != nil {
			rel = line
		}
		info.Importers = append(info.Importers, rel)
		if len(info.Importers) >= 5 {
			break
		}
	}
}

// analyzeGenericImpact uses grep to find files referencing this file.
func analyzeGenericImpact(info *ImpactInfo, filePath, cwd string) {
	base := filepath.Base(filePath)
	nameNoExt := strings.TrimSuffix(base, filepath.Ext(base))
	if nameNoExt == "" {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	// Search for import/require/from statements referencing this file.
	cmd := exec.CommandContext(ctx, "grep", "-rl", "--include=*.ts",
		"--include=*.tsx", "--include=*.js", "--include=*.jsx",
		"--include=*.py", "--include=*.rb",
		nameNoExt, cwd)
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return
	}

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" || line == filePath {
			continue
		}
		rel, err := filepath.Rel(cwd, line)
		if err != nil {
			rel = line
		}
		info.Importers = append(info.Importers, rel)
		if len(info.Importers) >= 5 {
			break
		}
	}
}

// findTestFiles looks for test files associated with the target file.
func findTestFiles(info *ImpactInfo, filePath, cwd string) {
	dir := filepath.Dir(filePath)
	base := filepath.Base(filePath)
	ext := filepath.Ext(base)
	nameNoExt := strings.TrimSuffix(base, ext)

	// Go: *_test.go in same directory.
	if ext == ".go" {
		pattern := filepath.Join(dir, "*_test.go")
		matches, _ := filepath.Glob(pattern)
		for _, m := range matches {
			rel, err := filepath.Rel(cwd, m)
			if err != nil {
				rel = m
			}
			info.TestFiles = append(info.TestFiles, rel)
			if len(info.TestFiles) >= 3 {
				return
			}
		}
		return
	}

	// Generic: look for common test naming patterns.
	testPatterns := []string{
		nameNoExt + "_test" + ext,
		nameNoExt + ".test" + ext,
		nameNoExt + ".spec" + ext,
		nameNoExt + "_test.py",
		"test_" + nameNoExt + ".py",
	}

	for _, tp := range testPatterns {
		candidate := filepath.Join(dir, tp)
		if _, err := os.Stat(candidate); err == nil {
			rel, _ := filepath.Rel(cwd, candidate)
			info.TestFiles = append(info.TestFiles, rel)
		}
	}

	// Also check __tests__ subdirectory.
	testsDir := filepath.Join(dir, "__tests__")
	if _, err := os.Stat(testsDir); err == nil {
		for _, tp := range testPatterns {
			candidate := filepath.Join(testsDir, tp)
			if _, err := os.Stat(candidate); err == nil {
				rel, _ := filepath.Rel(cwd, candidate)
				info.TestFiles = append(info.TestFiles, rel)
			}
		}
	}
}

// findCoChanges uses git log to find files frequently changed alongside the target file.
func findCoChanges(info *ImpactInfo, filePath, cwd string) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	// Get files that changed in the same commits as filePath (last 20 commits).
	relPath, err := filepath.Rel(cwd, filePath)
	if err != nil {
		relPath = filePath
	}

	out, err := execGit(ctx, cwd, "log", "--pretty=format:", "--name-only", "--follow", "-20", "--", relPath)
	if err != nil || strings.TrimSpace(out) == "" {
		return
	}

	// Count co-occurrence of each file.
	freq := make(map[string]int)
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == relPath {
			continue
		}
		freq[line]++
	}

	// Collect files that appeared in 3+ commits (strong co-change signal).
	for f, count := range freq {
		if count >= 3 && len(info.CoChanges) < 5 {
			info.CoChanges = append(info.CoChanges, f)
		}
	}
}

// computeBlastScore computes a composite risk score (0-100) from impact signals.
func computeBlastScore(info *ImpactInfo) int {
	score := 0
	// Importers: each adds 10 points (max 50).
	importerPts := len(info.Importers) * 10
	if importerPts > 50 {
		importerPts = 50
	}
	score += importerPts

	// No tests: +20 points.
	if len(info.TestFiles) == 0 {
		score += 20
	}

	// Co-changes: each adds 5 points (max 15).
	coChangePts := len(info.CoChanges) * 5
	if coChangePts > 15 {
		coChangePts = 15
	}
	score += coChangePts

	// Exported symbols: each adds 2 points (max 15).
	exportPts := info.ExportedN * 2
	if exportPts > 15 {
		exportPts = 15
	}
	score += exportPts

	// Transitive importers: each adds 3 points (max 15).
	transitPts := info.TransitiveImporterN * 3
	if transitPts > 15 {
		transitPts = 15
	}
	score += transitPts

	// Domain risk: +10 for sensitive domains.
	if info.DomainRisk != "" {
		score += 10
	}

	if score > 100 {
		score = 100
	}
	return score
}

// assessRisk determines the risk level based on blast score and impact analysis.
func assessRisk(info *ImpactInfo) string {
	if info.BlastScore >= 50 {
		return "high"
	}
	if info.BlastScore >= 25 {
		return "medium"
	}
	return "low"
}

// formatImpact formats impact info for inclusion in alternatives.
func formatImpact(info *ImpactInfo) string {
	if info == nil {
		return ""
	}
	if len(info.Importers) == 0 && len(info.TestFiles) == 0 && len(info.CoChanges) == 0 && info.BlastScore == 0 {
		return ""
	}

	var parts []string
	if len(info.Importers) > 0 {
		parts = append(parts, fmt.Sprintf("%d file(s) reference this: %s",
			len(info.Importers), strings.Join(info.Importers, ", ")))
	}
	if info.TransitiveImporterN > 0 {
		parts = append(parts, fmt.Sprintf("%d transitive importer(s)", info.TransitiveImporterN))
	}
	if len(info.TestFiles) > 0 {
		parts = append(parts, fmt.Sprintf("Tests: %s", strings.Join(info.TestFiles, ", ")))
	}
	if len(info.CoChanges) > 0 {
		parts = append(parts, fmt.Sprintf("Co-changes: %s", strings.Join(info.CoChanges, ", ")))
	}
	if info.SuggestedTestCmd != "" {
		parts = append(parts, fmt.Sprintf("Run: %s", info.SuggestedTestCmd))
	}
	if info.DomainRisk != "" {
		parts = append(parts, fmt.Sprintf("Domain risk: %s", info.DomainRisk))
	}
	if info.BlastScore > 0 {
		parts = append(parts, fmt.Sprintf("Blast radius: %d/100 (%s)", info.BlastScore, info.Risk))
	}
	return strings.Join(parts, "; ")
}

// coChangeHint checks the persistent store for files frequently co-changed
// with the given file and returns a hint if strong associations exist.
func coChangeHint(filePath string) string {
	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

	coChanges, err := st.CoChangedFiles(filePath, 3)
	if err != nil || len(coChanges) == 0 {
		return ""
	}

	var suggestions []string
	for _, cc := range coChanges {
		if cc.SessionCount < 3 {
			continue
		}
		other := cc.FileB
		if other == filePath {
			other = cc.FileA
		}
		suggestions = append(suggestions, fmt.Sprintf("%s (%d sessions)", filepath.Base(other), cc.SessionCount))
	}
	if len(suggestions) == 0 {
		return ""
	}

	return fmt.Sprintf("[buddy] Co-changed files: %s — changed together across sessions (structural coupling)", strings.Join(suggestions, ", "))
}

// classifyDomainRisk returns a domain-specific risk note based on file path.
// Returns "" for general/low-risk domains.
func classifyDomainRisk(filePath string) string {
	lower := strings.ToLower(filePath)

	switch {
	case containsAny(lower, "auth", "login", "password", "token", "credential", "jwt", "oauth"):
		return "auth — changes may affect authentication/authorization security"
	case containsAny(lower, "migration", "schema"):
		return "database schema — changes may require migration coordination"
	case containsAny(lower, "middleware", "interceptor"):
		return "middleware — changes affect all requests passing through"
	case containsAny(lower, "deploy", "docker", "k8s", "terraform", "ci", "pipeline"):
		return "infra — changes affect deployment and availability"
	case containsAny(lower, "crypto", "encrypt", "secret", "key"):
		return "security — changes involve cryptographic or secret handling"
	default:
		return ""
	}
}

// GoExportedSymbols extracts exported symbol names from a Go file.
// Used for deeper impact analysis when needed.
func GoExportedSymbols(filePath string) []string {
	fset := token.NewFileSet()
	src, err := os.ReadFile(filePath)
	if err != nil {
		return nil
	}
	file, err := parser.ParseFile(fset, filePath, src, 0)
	if err != nil {
		return nil
	}

	var symbols []string
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Name.IsExported() {
				symbols = append(symbols, d.Name.Name)
			}
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					if s.Name.IsExported() {
						symbols = append(symbols, s.Name.Name)
					}
				case *ast.ValueSpec:
					for _, name := range s.Names {
						if name.IsExported() {
							symbols = append(symbols, name.Name)
						}
					}
				}
			}
		}
	}
	return symbols
}
