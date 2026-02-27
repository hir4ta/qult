package hookhandler

import "testing"

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
			wantAfter: "except (ValueError, TypeError) as e:",
			wantConf:  0.6,
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
			wantAfter: "// console.log('debug');  // TODO: remove debug log",
			wantConf:  0.7,
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
			name:      "var usage",
			finding:   Finding{Rule: "js_var_usage", Line: 1, File: "app.js"},
			content:   "var count = 0;\n",
			wantAfter: "const count = 0;",
			wantConf:  0.75,
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
