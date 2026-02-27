package hookhandler

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// CoverageMap maps source functions to their test names and test file paths.
type CoverageMap struct {
	// FuncToTests maps "pkg.FuncName" → ["TestFuncName", "TestFuncName_error"]
	FuncToTests map[string][]string `json:"func_to_tests"`
	// FileToTestFile maps source file path → test file path
	FileToTestFile map[string]string `json:"file_to_test_file"`
}

// GenerateCoverageMap builds a coverage map for Go files in the given directory
// by scanning test files and matching Test* function names to source functions.
// This is a lightweight alternative to running `go test -coverprofile`.
func GenerateCoverageMap(cwd string) *CoverageMap {
	cm := &CoverageMap{
		FuncToTests:    make(map[string][]string),
		FileToTestFile: make(map[string]string),
	}

	// Walk Go files in the project.
	_ = filepath.Walk(cwd, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			// Skip hidden dirs and vendor.
			if info != nil && info.IsDir() {
				name := info.Name()
				if strings.HasPrefix(name, ".") || name == "vendor" || name == "node_modules" {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if !strings.HasSuffix(path, "_test.go") {
			return nil
		}

		// Found a test file — find its source file and extract test→func mappings.
		sourceFile := strings.TrimSuffix(path, "_test.go") + ".go"
		if _, serr := os.Stat(sourceFile); serr != nil {
			return nil
		}

		relPath, _ := filepath.Rel(cwd, sourceFile)
		if relPath == "" {
			relPath = sourceFile
		}
		cm.FileToTestFile[relPath] = path

		// Parse test file to extract test function names.
		testFuncs := extractTestFunctions(path)
		if len(testFuncs) == 0 {
			return nil
		}

		// Parse source file to extract function names.
		sourceFuncs := extractSourceFunctions(sourceFile)

		// Match test functions to source functions by name convention.
		for _, srcFunc := range sourceFuncs {
			key := relPath + ":" + srcFunc
			for _, testFunc := range testFuncs {
				if testCoversFunc(testFunc, srcFunc) {
					cm.FuncToTests[key] = append(cm.FuncToTests[key], testFunc)
				}
			}
		}

		return nil
	})

	return cm
}

// testCoversFunc checks if a test function name likely tests the given source function.
// Conventions: TestFuncName, TestFuncName_suffix, TestReceiverName_MethodName
func testCoversFunc(testName, funcName string) bool {
	// Strip "Test" prefix.
	stripped := strings.TrimPrefix(testName, "Test")
	if stripped == "" {
		return false
	}

	// Direct match: TestFuncName → FuncName
	if stripped == funcName {
		return true
	}

	// Suffix match: TestFuncName_error → FuncName
	if idx := strings.Index(stripped, "_"); idx > 0 {
		if stripped[:idx] == funcName {
			return true
		}
	}

	// Receiver method: TestReceiver_Method → Receiver.Method
	if strings.Contains(funcName, ".") {
		parts := strings.SplitN(funcName, ".", 2)
		// TestStore_InsertFeedback → Store.InsertFeedback
		if stripped == parts[0]+parts[1] || stripped == parts[0]+"_"+parts[1] {
			return true
		}
	}

	return false
}

// extractTestFunctions returns Test* function names from a Go test file.
func extractTestFunctions(path string) []string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		return nil
	}

	var names []string
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil {
			continue
		}
		if strings.HasPrefix(fn.Name.Name, "Test") {
			names = append(names, fn.Name.Name)
		}
	}
	return names
}

// extractSourceFunctions returns all exported function names from a Go source file.
func extractSourceFunctions(path string) []string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		return nil
	}

	var names []string
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		name := funcName(fn)
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}

// SuggestTestCommand builds a specific `go test -run` command for changed functions.
// Falls back to running all tests in the package if no specific tests are found.
func SuggestTestCommand(cm *CoverageMap, filePath string, changedFuncs []string, cwd string) string {
	if cm == nil {
		return suggestFallbackTestCommand(filePath, cwd)
	}

	relPath, _ := filepath.Rel(cwd, filePath)
	if relPath == "" {
		relPath = filePath
	}

	// Collect matching test names.
	var testNames []string
	seen := make(map[string]bool)
	for _, fn := range changedFuncs {
		key := relPath + ":" + fn
		for _, t := range cm.FuncToTests[key] {
			if !seen[t] {
				seen[t] = true
				testNames = append(testNames, t)
			}
		}
	}

	pkg := "./" + filepath.Dir(relPath)
	if pkg == "./" || pkg == "./." {
		pkg = "./..."
	}

	if len(testNames) > 0 {
		pattern := strings.Join(testNames, "|")
		return "go test -run '" + pattern + "' " + pkg
	}

	return suggestFallbackTestCommand(filePath, cwd)
}

// suggestFallbackTestCommand returns a package-level test command.
func suggestFallbackTestCommand(filePath, cwd string) string {
	rel, _ := filepath.Rel(cwd, filePath)
	if rel == "" {
		return ""
	}
	pkg := "./" + filepath.Dir(rel)
	if pkg == "./" || pkg == "./." {
		return "go test ./..."
	}
	return "go test " + pkg + "/..."
}

// UntestedFunctions returns exported function names that have no matching test.
func (cm *CoverageMap) UntestedFunctions(relPath string, funcs []string) []string {
	if cm == nil {
		return nil
	}
	var untested []string
	for _, fn := range funcs {
		key := relPath + ":" + fn
		if len(cm.FuncToTests[key]) == 0 {
			untested = append(untested, fn)
		}
	}
	return untested
}

// SaveCoverageMap serializes the coverage map to sessiondb.
func SaveCoverageMap(sdb *sessiondb.SessionDB, cm *CoverageMap) {
	data, err := json.Marshal(cm)
	if err != nil {
		return
	}
	_ = sdb.SetContext("coverage_map", string(data))
}

// LoadCoverageMap deserializes the coverage map from sessiondb.
func LoadCoverageMap(sdb *sessiondb.SessionDB) *CoverageMap {
	data, _ := sdb.GetContext("coverage_map")
	if data == "" {
		return nil
	}
	var cm CoverageMap
	if err := json.Unmarshal([]byte(data), &cm); err != nil {
		return nil
	}
	return &cm
}
