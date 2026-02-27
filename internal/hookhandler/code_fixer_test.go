package hookhandler

import (
	goparser "go/parser"
	"go/token"
	"strings"
	"testing"
)

func TestPythonFixer(t *testing.T) {
	t.Parallel()
	fixer := &pythonFixer{}

	tests := []struct {
		name       string
		finding    Finding
		content    string
		wantAfter  string
		wantNil    bool
		wantConf   float64
	}{
		{
			name:      "bare except",
			finding:   Finding{Rule: "py_bare_except", Line: 1, File: "app.py"},
			content:   "    except:\n",
			wantAfter: "except Exception:",
			wantConf:  0.9,
		},
		{
			name:      "bare except via message",
			finding:   Finding{Message: "bare `except:`", Line: 1, File: "app.py"},
			content:   "except:\n",
			wantAfter: "except Exception:",
			wantConf:  0.9,
		},
		{
			name:    "mutable default list",
			finding: Finding{Rule: "py_mutable_default", Line: 1, File: "app.py"},
			content: "def process(items=[]):\n",
			wantAfter: "def process(items=None):",
			wantConf:  0.85,
		},
		{
			name:    "mutable default dict",
			finding: Finding{Rule: "py_mutable_default", Line: 1, File: "app.py"},
			content: "def process(config={}):\n",
			wantAfter: "def process(config=None):",
			wantConf:  0.85,
		},
		{
			name:    "mutable default not a def line",
			finding: Finding{Rule: "py_mutable_default", Line: 1, File: "app.py"},
			content: "items = []\n",
			wantNil: true,
		},
		{
			name:      "broad exception",
			finding:   Finding{Rule: "py_broad_exception", Line: 1, File: "app.py"},
			content:   "    except Exception as e:\n",
			wantAfter: "except (<SpecificError1>, <SpecificError2>) as e:",
			wantConf:  0.35,
		},
		{
			name:      "star import",
			finding:   Finding{Rule: "py_star_import", Line: 1, File: "app.py"},
			content:   "from os.path import *\n",
			wantAfter: "from os.path import specific_name  # list needed names explicitly",
			wantConf:  0.7,
		},
		{
			name:    "unknown rule",
			finding: Finding{Rule: "unknown", Line: 1, File: "app.py"},
			content: "x = 1\n",
			wantNil: true,
		},
		{
			name:    "line out of range",
			finding: Finding{Rule: "py_bare_except", Line: 99, File: "app.py"},
			content: "except:\n",
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fix := fixer.Fix(tt.finding, []byte(tt.content))
			if tt.wantNil {
				if fix != nil {
					t.Errorf("Fix() = %+v, want nil", fix)
				}
				return
			}
			if fix == nil {
				t.Fatal("Fix() = nil, want non-nil")
			}
			if fix.After != tt.wantAfter {
				t.Errorf("Fix().After = %q, want %q", fix.After, tt.wantAfter)
			}
			if fix.Confidence != tt.wantConf {
				t.Errorf("Fix().Confidence = %v, want %v", fix.Confidence, tt.wantConf)
			}
		})
	}
}

func TestJSFixer(t *testing.T) {
	t.Parallel()
	fixer := &jsFixer{}

	tests := []struct {
		name      string
		finding   Finding
		content   string
		wantAfter string
		wantNil   bool
		wantConf  float64
	}{
		{
			name:      "console.log",
			finding:   Finding{Rule: "js_console_log", Line: 1, File: "app.js"},
			content:   "  console.log('debug');\n",
			wantAfter: "(delete this line)",
			wantConf:  0.75,
		},
		{
			name:      "loose equality ==",
			finding:   Finding{Rule: "js_loose_equality", Line: 1, File: "app.js"},
			content:   "if (x == null) {\n",
			wantAfter: "if (x === null) {",
			wantConf:  0.85,
		},
		{
			name:    "strict equality already",
			finding: Finding{Rule: "js_loose_equality", Line: 1, File: "app.js"},
			content: "if (x === null) {\n",
			wantNil: true,
		},
		{
			name:      "var usage const",
			finding:   Finding{Rule: "js_var_usage", Line: 1, File: "app.js"},
			content:   "var count = 0;\n",
			wantAfter: "const count = 0;",
			wantConf:  0.8,
		},
		{
			name:      "var usage let (reassigned)",
			finding:   Finding{Rule: "js_var_usage", Line: 1, File: "app.js"},
			content:   "var count = 0;\ncount = count + 1;\n",
			wantAfter: "let count = 0;",
			wantConf:  0.8,
		},
		{
			name:    "var not at start",
			finding: Finding{Rule: "js_var_usage", Line: 1, File: "app.js"},
			content: "// no var here\n",
			wantNil: true,
		},
		{
			name:      "empty catch",
			finding:   Finding{Rule: "js_empty_catch", Line: 1, File: "app.js"},
			content:   "} catch (err) {}\n",
			wantAfter: "} catch (err) { console.error(err); }",
			wantConf:  0.8,
		},
		{
			name:      "empty catch no name",
			finding:   Finding{Rule: "js_empty_catch", Line: 1, File: "app.js"},
			content:   "} catch () {}\n",
			wantAfter: "} catch (e) { console.error(e); }",
			wantConf:  0.8,
		},
		{
			name:    "unknown rule",
			finding: Finding{Rule: "unknown", Line: 1, File: "app.js"},
			content: "x = 1;\n",
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fix := fixer.Fix(tt.finding, []byte(tt.content))
			if tt.wantNil {
				if fix != nil {
					t.Errorf("Fix() = %+v, want nil", fix)
				}
				return
			}
			if fix == nil {
				t.Fatal("Fix() = nil, want non-nil")
			}
			if fix.After != tt.wantAfter {
				t.Errorf("Fix().After = %q, want %q", fix.After, tt.wantAfter)
			}
			if fix.Confidence != tt.wantConf {
				t.Errorf("Fix().Confidence = %v, want %v", fix.Confidence, tt.wantConf)
			}
		})
	}
}

func TestRustFixer(t *testing.T) {
	t.Parallel()
	fixer := &rustFixer{}

	tests := []struct {
		name      string
		finding   Finding
		content   string
		wantAfter string
		wantNil   bool
		wantConf  float64
	}{
		{
			name:      "unwrap in Result fn",
			finding:   Finding{Rule: "rs-unwrap", Line: 3, File: "main.rs"},
			content:   "pub fn process() -> Result<(), Error> {\n    let x = 1;\n    let val = result.unwrap();\n}\n",
			wantAfter: "let val = result?;",
			wantConf:  0.8,
		},
		{
			name:      "unwrap via message in Result fn",
			finding:   Finding{Message: ".unwrap() on Result/Option", Line: 2, File: "lib.rs"},
			content:   "fn load() -> Option<String> {\n    let data = file.read_to_string().unwrap();\n}\n",
			wantAfter: "let data = file.read_to_string()?;",
			wantConf:  0.8,
		},
		{
			name:    "unwrap in non-Result fn",
			finding: Finding{Rule: "rs-unwrap", Line: 2, File: "lib.rs"},
			content: "fn main() {\n    let val = result.unwrap();\n}\n",
			wantNil: true,
		},
		{
			name:     "unwrap unknown context",
			finding:  Finding{Rule: "rs-unwrap", Line: 1, File: "lib.rs"},
			content:  "let val = result.unwrap();\n",
			wantConf: 0.55,
		},
		{
			name:    "no unwrap on line",
			finding: Finding{Rule: "rs-unwrap", Line: 1, File: "lib.rs"},
			content: "let val = result?;\n",
			wantNil: true,
		},
		{
			name:      "todo macro",
			finding:   Finding{Rule: "rs-todo-macro", Line: 1, File: "lib.rs"},
			content:   `    todo!("handle this case");` + "\n",
			wantAfter: `unimplemented!("handle this case");`,
			wantConf:  0.7,
		},
		{
			name:      "unsafe no safety",
			finding:   Finding{Rule: "rs-unsafe-no-safety", Line: 1, File: "lib.rs"},
			content:   "    unsafe { ptr.write(val); }\n",
			wantAfter: "// SAFETY: TODO document the invariants that make this sound\n    unsafe { ptr.write(val); }",
			wantConf:  0.85,
		},
		{
			name:    "clone overuse low confidence",
			finding: Finding{Rule: "rs-clone-overuse", File: "lib.rs"},
			content: "let a = x.clone();\n",
			wantConf: 0.5,
		},
		{
			name:    "unknown rule",
			finding: Finding{Rule: "unknown", Line: 1, File: "lib.rs"},
			content: "let x = 1;\n",
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fix := fixer.Fix(tt.finding, []byte(tt.content))
			if tt.wantNil {
				if fix != nil {
					t.Errorf("Fix() = %+v, want nil", fix)
				}
				return
			}
			if fix == nil {
				t.Fatal("Fix() = nil, want non-nil")
			}
			if tt.wantAfter != "" && fix.After != tt.wantAfter {
				t.Errorf("Fix().After = %q, want %q", fix.After, tt.wantAfter)
			}
			if fix.Confidence != tt.wantConf {
				t.Errorf("Fix().Confidence = %v, want %v", fix.Confidence, tt.wantConf)
			}
		})
	}
}

func TestGoFixer(t *testing.T) {
	t.Parallel()
	fixer := &goFixer{}

	tests := []struct {
		name      string
		finding   Finding
		content   string
		wantAfter string
		wantNil   bool
		wantConf  float64
	}{
		{
			name:    "defer in for loop",
			finding: Finding{Rule: "go_defer_in_loop", Line: 3, File: "main.go"},
			content: "package main\nfunc run() {\n\tfor i := 0; i < 10; i++ {\n\t\tdefer f.Close()\n\t}\n}\n",
			wantAfter: "func() { defer f.Close() }()",
			wantConf:  0.9,
		},
		{
			name:    "defer in range loop",
			finding: Finding{Rule: "go_defer_in_loop", Line: 3, File: "main.go"},
			content: "package main\nfunc run() {\n\tfor _, f := range files {\n\t\tdefer f.Close()\n\t}\n}\n",
			wantAfter: "func() { defer f.Close() }()",
			wantConf:  0.9,
		},
		{
			name:    "defer not in loop",
			finding: Finding{Rule: "go_defer_in_loop", Line: 2, File: "main.go"},
			content: "package main\nfunc run() {\n\tdefer f.Close()\n}\n",
			wantNil: true,
		},
		{
			name:    "nil error wrap",
			finding: Finding{Rule: "go_nil_error_wrap", Line: 1, File: "main.go"},
			content: `fmt.Errorf("failed to open: %w", nil)` + "\n",
			wantAfter: `fmt.Errorf("failed to open")`,
			wantConf:  0.95,
		},
		{
			name:    "nil error wrap no match",
			finding: Finding{Rule: "go_nil_error_wrap", Line: 1, File: "main.go"},
			content: `fmt.Errorf("failed: %w", err)` + "\n",
			wantNil: true,
		},
		{
			name:    "empty error return in error func",
			finding: Finding{Rule: "go_empty_error_return", Line: 4, File: "main.go"},
			content: "package main\n\nfunc validate() error {\n\tif err != nil { return nil }\n\treturn nil\n}\n",
			wantAfter: "if err != nil { return err }",
			wantConf:  0.9,
		},
		{
			name:    "empty error return in non-error func",
			finding: Finding{Rule: "go_empty_error_return", Line: 4, File: "main.go"},
			content: "package main\n\nfunc getUser() *User {\n\tif err != nil { return nil }\n\treturn nil\n}\n",
			wantNil: true,
		},
		{
			name:    "empty error return snippet no ast",
			finding: Finding{Rule: "go_empty_error_return", Line: 1, File: "main.go"},
			content: "if err != nil { return nil }\n",
			wantAfter: "if err != nil { return err }",
			wantConf:  0.65,
		},
		{
			name:    "error shadow err only",
			finding: Finding{Message: "Error variable shadowed", Line: 1, File: "main.go"},
			content: "err := doSomething()\n",
			wantAfter: "err = doSomething()",
			wantConf:  0.7,
		},
		{
			name:    "error shadow with other vars",
			finding: Finding{Message: "Error variable shadowed", Line: 1, File: "main.go"},
			content: "result, err := doSomething()\n",
			wantAfter: "result, err = doSomething()",
			wantConf:  0.4,
		},
		{
			name:    "error shadow with underscore",
			finding: Finding{Message: "Error variable shadowed", Line: 1, File: "main.go"},
			content: "_, err := doSomething()\n",
			wantAfter: "_, err = doSomething()",
			wantConf:  0.7,
		},
		{
			name:    "error shadow no := on line",
			finding: Finding{Message: "Error variable shadowed", Line: 1, File: "main.go"},
			content: "err = doSomething()\n",
			wantNil: true,
		},
		{
			name:    "unknown rule",
			finding: Finding{Rule: "unknown", Line: 1, File: "main.go"},
			content: "x := 1\n",
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fix := fixer.Fix(tt.finding, []byte(tt.content))
			if tt.wantNil {
				if fix != nil {
					t.Errorf("Fix() = %+v, want nil", fix)
				}
				return
			}
			if fix == nil {
				t.Fatal("Fix() = nil, want non-nil")
			}
			if tt.wantAfter != "" && fix.After != tt.wantAfter {
				t.Errorf("Fix().After = %q, want %q", fix.After, tt.wantAfter)
			}
			if fix.Confidence != tt.wantConf {
				t.Errorf("Fix().Confidence = %v, want %v", fix.Confidence, tt.wantConf)
			}
		})
	}
}

// TestGoFixerSemanticValidity verifies that GoFixer patches produce compilable Go code
// by applying the fix (Before→After replacement) and parsing the result with go/ast.
func TestGoFixerSemanticValidity(t *testing.T) {
	t.Parallel()
	fixer := &goFixer{}

	tests := []struct {
		name    string
		finding Finding
		content string
	}{
		{
			name:    "defer in loop produces valid Go",
			finding: Finding{Rule: "go_defer_in_loop", Line: 3, File: "main.go"},
			content: "package main\n\nimport \"os\"\n\nfunc run(files []*os.File) {\n\tfor _, f := range files {\n\t\tdefer f.Close()\n\t}\n}\n",
		},
		{
			name:    "empty error return produces valid Go",
			finding: Finding{Rule: "go_empty_error_return", Line: 4, File: "main.go"},
			content: "package main\n\nfunc validate(err error) error {\n\tif err != nil { return nil }\n\treturn nil\n}\n",
		},
		{
			name:    "error shadow produces valid Go",
			finding: Finding{Message: "Error variable shadowed", Line: 5, File: "main.go"},
			content: "package main\n\nfunc run() error {\n\tvar err error\n\terr := doSomething()\n\treturn err\n}\n\nfunc doSomething() error { return nil }\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fix := fixer.Fix(tt.finding, []byte(tt.content))
			if fix == nil {
				t.Fatal("Fix() = nil, want non-nil")
			}

			// Apply the patch.
			patched := strings.Replace(tt.content, fix.Before, fix.After, 1)

			// Parse the patched source — it must be syntactically valid Go.
			fset := token.NewFileSet()
			_, err := goparser.ParseFile(fset, tt.finding.File, patched, 0)
			if err != nil {
				t.Errorf("Patched source is not valid Go:\n--- patch ---\n%s → %s\n--- source ---\n%s\n--- error ---\n%v",
					fix.Before, fix.After, patched, err)
			}
		})
	}
}

// TestPythonFixerSemanticValidity verifies Python patches produce parseable code.
// Uses tree-sitter where the grammar supports it, and structural checks otherwise.
// Note: gotreesitter's Python grammar has false positives on try/except blocks.
func TestPythonFixerSemanticValidity(t *testing.T) {
	t.Parallel()
	fixer := &pythonFixer{}

	tests := []struct {
		name    string
		finding Finding
		content string
		useTS   bool // false = structural check only (tree-sitter grammar limitation)
	}{
		{
			name:    "bare except preserves structure",
			finding: Finding{Rule: "py_bare_except", Line: 1, File: "app.py"},
			content: "except:\n    pass\n",
			useTS:   false, // tree-sitter Python marks all try/except as ERROR
		},
		{
			name:    "mutable default produces valid Python",
			finding: Finding{Rule: "py_mutable_default", Line: 1, File: "app.py"},
			content: "def process(items=[]):\n    return items\n",
			useTS:   true,
		},
		{
			name:    "star import produces valid Python",
			finding: Finding{Rule: "py_star_import", Line: 1, File: "app.py"},
			content: "from os.path import *\n",
			useTS:   true,
		},
	}

	ts := NewTreeSitterAnalyzer().(*tsAnalyzer)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fix := fixer.Fix(tt.finding, []byte(tt.content))
			if fix == nil {
				t.Fatal("Fix() = nil, want non-nil")
			}
			patched := strings.Replace(tt.content, fix.Before, fix.After, 1)
			if tt.useTS {
				assertTreeSitterValid(t, ts, "py", tt.finding.File, patched)
			} else {
				// Structural check: patch applied and result is non-empty.
				if patched == tt.content {
					t.Error("patch did not modify the source")
				}
				if fix.Before == fix.After {
					t.Error("Before == After, no-op fix")
				}
			}
		})
	}
}

// TestJSFixerSemanticValidity verifies JS patches produce parseable code.
func TestJSFixerSemanticValidity(t *testing.T) {
	t.Parallel()
	fixer := &jsFixer{}

	tests := []struct {
		name    string
		finding Finding
		content string
	}{
		{
			name:    "loose equality produces valid JS",
			finding: Finding{Rule: "js_loose_equality", Line: 1, File: "app.js"},
			content: "if (x == null) {\n  return true;\n}\n",
		},
		{
			name:    "var usage produces valid JS",
			finding: Finding{Rule: "js_var_usage", Line: 1, File: "app.js"},
			content: "var count = 0;\nfor (var i = 0; i < 10; i++) { count++; }\n",
		},
		{
			name:    "empty catch produces valid JS",
			finding: Finding{Rule: "js_empty_catch", Line: 2, File: "app.js"},
			content: "try {\n} catch (err) {}\n",
		},
	}

	ts := NewTreeSitterAnalyzer().(*tsAnalyzer)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fix := fixer.Fix(tt.finding, []byte(tt.content))
			if fix == nil {
				t.Fatal("Fix() = nil, want non-nil")
			}
			patched := strings.Replace(tt.content, fix.Before, fix.After, 1)
			assertTreeSitterValid(t, ts, "js", tt.finding.File, patched)
		})
	}
}

// TestRustFixerSemanticValidity verifies Rust patches produce parseable code.
// Note: gotreesitter's Rust grammar has false positives when comments are inserted.
func TestRustFixerSemanticValidity(t *testing.T) {
	t.Parallel()
	fixer := &rustFixer{}

	tests := []struct {
		name    string
		finding Finding
		content string
		useTS   bool
	}{
		{
			name:    "unwrap to ? produces valid Rust",
			finding: Finding{Rule: "rs-unwrap", Line: 2, File: "lib.rs"},
			content: "fn load() -> Result<(), Box<dyn std::error::Error>> {\n    let data = file.read().unwrap();\n    Ok(())\n}\n",
			useTS:   true,
		},
		{
			name:    "todo to unimplemented produces valid Rust",
			finding: Finding{Rule: "rs-todo-macro", Line: 2, File: "lib.rs"},
			content: "fn process() {\n    todo!(\"handle this\");\n}\n",
			useTS:   true,
		},
		{
			name:    "unsafe safety comment preserves structure",
			finding: Finding{Rule: "rs-unsafe-no-safety", Line: 2, File: "lib.rs"},
			content: "fn run() {\n    unsafe { ptr.write(val); }\n}\n",
			useTS:   false, // tree-sitter Rust grammar false-positives on inserted comments
		},
	}

	ts := NewTreeSitterAnalyzer().(*tsAnalyzer)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fix := fixer.Fix(tt.finding, []byte(tt.content))
			if fix == nil {
				t.Fatal("Fix() = nil, want non-nil")
			}
			patched := strings.Replace(tt.content, fix.Before, fix.After, 1)
			if tt.useTS {
				assertTreeSitterValid(t, ts, "rs", tt.finding.File, patched)
			} else {
				if patched == tt.content {
					t.Error("patch did not modify the source")
				}
				// Comment insertion: verify original unsafe block is preserved.
				if !strings.Contains(patched, "unsafe") {
					t.Error("patched code lost the unsafe block")
				}
				if !strings.Contains(patched, "// SAFETY:") {
					t.Error("patched code missing SAFETY comment")
				}
			}
		})
	}
}

// assertTreeSitterValid parses code with tree-sitter and fails if ERROR nodes are found.
func assertTreeSitterValid(t *testing.T, ts *tsAnalyzer, ext, fileName, source string) {
	t.Helper()
	parser, _ := ts.getParser(ext)
	if parser == nil {
		t.Skipf("no tree-sitter parser for %q", ext)
		return
	}
	tree, err := parser.Parse([]byte(source))
	if err != nil {
		t.Errorf("tree-sitter parse error for %s: %v\nsource:\n%s", fileName, err, source)
		return
	}
	defer tree.Release()

	root := tree.RootNode()
	if root == nil {
		t.Errorf("tree-sitter returned nil root for %s", fileName)
		return
	}
	if root.HasError() {
		t.Errorf("Patched %s has syntax errors (tree-sitter ERROR node):\n%s", fileName, source)
	}
}

func TestGetFixer(t *testing.T) {
	t.Parallel()
	tests := []struct {
		path string
		want bool
	}{
		{"main.go", true},
		{"app.py", true},
		{"index.js", true},
		{"app.ts", true},
		{"component.tsx", true},
		{"component.jsx", true},
		{"lib.rs", true},
		{"README.md", false},
		{"data.json", false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			t.Parallel()
			got := GetFixer(tt.path)
			if (got != nil) != tt.want {
				t.Errorf("GetFixer(%q) = %v, want non-nil=%v", tt.path, got, tt.want)
			}
		})
	}
}

func TestUntestedFunctions(t *testing.T) {
	t.Parallel()

	cm := &CoverageMap{
		FuncToTests: map[string][]string{
			"pkg/handler.go:HandleRequest":  {"TestHandleRequest"},
			"pkg/handler.go:ValidateInput":  {"TestValidateInput"},
		},
	}

	tests := []struct {
		name    string
		funcs   []string
		wantLen int
	}{
		{
			"all tested",
			[]string{"HandleRequest", "ValidateInput"},
			0,
		},
		{
			"one untested",
			[]string{"HandleRequest", "ProcessData"},
			1,
		},
		{
			"all untested",
			[]string{"ProcessData", "Cleanup"},
			2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := cm.UntestedFunctions("pkg/handler.go", tt.funcs)
			if len(got) != tt.wantLen {
				t.Errorf("UntestedFunctions() = %v (len %d), want len %d", got, len(got), tt.wantLen)
			}
		})
	}

	t.Run("nil coverage map", func(t *testing.T) {
		t.Parallel()
		var nilCM *CoverageMap
		got := nilCM.UntestedFunctions("pkg/handler.go", []string{"Foo"})
		if got != nil {
			t.Errorf("UntestedFunctions on nil map = %v, want nil", got)
		}
	})
}

func TestGetLine(t *testing.T) {
	t.Parallel()
	content := []byte("line1\nline2\nline3\n")
	tests := []struct {
		line int
		want string
	}{
		{1, "line1"},
		{2, "line2"},
		{3, "line3"},
		{0, ""},
		{-1, ""},
		{99, ""},
	}
	for _, tt := range tests {
		got := getLine(content, tt.line)
		if got != tt.want {
			t.Errorf("getLine(content, %d) = %q, want %q", tt.line, got, tt.want)
		}
	}
}
