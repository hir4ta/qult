package hookhandler

import "testing"

func TestMultiAnalyzer_Go(t *testing.T) {
	t.Parallel()
	a := NewMultiAnalyzer()
	// Go file with error shadow — should be caught by goAnalyzer via AST.
	src := []byte(`package main
import "fmt"
func main() {
	err := fmt.Errorf("outer")
	if err != nil {
		err := fmt.Errorf("shadow")
		_ = err
	}
}
`)
	findings := a.Analyze("main.go", src)
	if len(findings) == 0 {
		t.Error("expected Go AST findings for error shadow, got none")
	}
}

func TestMultiAnalyzer_Python(t *testing.T) {
	t.Parallel()
	a := NewMultiAnalyzer()

	tests := []struct {
		name string
		src  string
		rule string
	}{
		{"bare except", "try:\n  pass\nexcept:\n  pass", "py-bare-except"},
		{"mutable default list", "def foo(x=[]):\n  pass", "py-mutable-default"},
		{"mutable default dict", "def foo(x={}):\n  pass", "py-mutable-default-dict"},
		{"star import", "from os import *", "py-star-import"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			findings := a.Analyze("app.py", []byte(tt.src))
			found := false
			for _, f := range findings {
				if f.Rule == tt.rule {
					found = true
				}
			}
			if !found {
				t.Errorf("expected finding with rule %q, got %v", tt.rule, findings)
			}
		})
	}
}

func TestMultiAnalyzer_JS(t *testing.T) {
	t.Parallel()
	a := NewMultiAnalyzer()

	tests := []struct {
		name string
		file string
		src  string
		rule string
		want bool
	}{
		{"console.log in source", "app.js", `console.log("debug")`, "js-console-log", true},
		{"console.log in test", "app.test.js", `console.log("debug")`, "js-console-log", false},
		{"loose equality", "app.ts", `if (x == 1) {}`, "js-loose-equality", true},
		{"unused import", "app.tsx", `import { Foo, Bar } from 'lib'\nconst x = Foo()`, "js-unused-import", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			findings := a.Analyze(tt.file, []byte(tt.src))
			found := false
			for _, f := range findings {
				if f.Rule == tt.rule {
					found = true
				}
			}
			if found != tt.want {
				t.Errorf("rule %q: found=%v, want=%v, findings=%v", tt.rule, found, tt.want, findings)
			}
		})
	}
}

func TestMultiAnalyzer_Rust(t *testing.T) {
	t.Parallel()
	a := NewMultiAnalyzer()

	tests := []struct {
		name string
		src  string
		rule string
		want bool
	}{
		{"unwrap in source", `fn main() { let x = foo().unwrap(); }`, "rs-unwrap", true},
		{"unwrap in test", "#[cfg(test)]\nmod tests { fn t() { foo().unwrap(); } }", "rs-unwrap", false},
		{"todo macro", `fn handle() { todo!("implement later") }`, "rs-todo-macro", true},
		{"unsafe no comment", `fn main() { unsafe { *ptr } }`, "rs-unsafe-no-safety", true},
		{"unsafe with safety", "// SAFETY: ptr is valid\nunsafe { *ptr }", "rs-unsafe-no-safety", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			findings := a.Analyze("lib.rs", []byte(tt.src))
			found := false
			for _, f := range findings {
				if f.Rule == tt.rule {
					found = true
				}
			}
			if found != tt.want {
				t.Errorf("rule %q: found=%v, want=%v, findings=%v", tt.rule, found, tt.want, findings)
			}
		})
	}
}

func TestMultiAnalyzer_UnsupportedLanguage(t *testing.T) {
	t.Parallel()
	a := NewMultiAnalyzer()
	findings := a.Analyze("data.csv", []byte("a,b,c"))
	if len(findings) != 0 {
		t.Errorf("expected no findings for unsupported language, got %v", findings)
	}
}

func TestRustHeuristics(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		check func(string, string) string
		file  string
		src   string
		want  bool
	}{
		{"unwrap detected", checkRustUnwrap, "lib.rs", "foo().unwrap()", true},
		{"unwrap in test", checkRustUnwrap, "lib_test.rs", "foo().unwrap()", false},
		{"todo macro", checkRustTodoMacro, "lib.rs", `todo!("later")`, true},
		{"unsafe no comment", checkRustUnsafeNoComment, "lib.rs", "unsafe { *p }", true},
		{"unsafe with safety", checkRustUnsafeNoComment, "lib.rs", "// SAFETY: ok\nunsafe { *p }", false},
		{"no issues", checkRustUnwrap, "lib.rs", "let x = foo()?;", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := tt.check(tt.file, tt.src)
			if (got != "") != tt.want {
				t.Errorf("%s(%q) = %q, wantMatch=%v", tt.name, tt.src, got, tt.want)
			}
		})
	}
}
