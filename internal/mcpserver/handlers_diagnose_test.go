package mcpserver

import "testing"

func TestClassifyError(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		tool     string
		errorMsg string
		want     string
	}{
		{"edit mismatch", "Edit", "old_string not found in file", "edit_mismatch"},
		{"file not found", "Read", "no such file or directory", "file_not_found"},
		{"permission", "Write", "permission denied", "permission"},
		{"compile error", "Bash", "internal/foo.go:10: undefined: bar", "compile_error"},
		{"test failure", "Bash", "--- FAIL: TestFoo (0.01s)", "test_failure"},
		{"generic edit", "Edit", "something went wrong", "edit_mismatch"},
		{"generic bash", "Bash", "command exited with code 1", "runtime_error"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := classifyError(tt.tool, tt.errorMsg)
			if got != tt.want {
				t.Errorf("classifyError(%q, %q) = %q, want %q", tt.tool, tt.errorMsg, got, tt.want)
			}
		})
	}
}

func TestParseStackFrames(t *testing.T) {
	t.Parallel()

	t.Run("go stack", func(t *testing.T) {
		t.Parallel()
		input := `goroutine 1 [running]:
	main.go:42 +0x1a
	handler.go:15 +0x2b`
		frames := parseStackFrames(input)
		if len(frames) != 2 {
			t.Fatalf("got %d frames, want 2", len(frames))
		}
		if frames[0].File != "main.go" || frames[0].Line != "42" {
			t.Errorf("frame[0] = %+v, want main.go:42", frames[0])
		}
	})

	t.Run("python stack", func(t *testing.T) {
		t.Parallel()
		input := `Traceback (most recent call last):
  File "app.py", line 10, in main
  File "utils.py", line 5, in helper`
		frames := parseStackFrames(input)
		if len(frames) != 2 {
			t.Fatalf("got %d frames, want 2", len(frames))
		}
		if frames[0].File != "app.py" || frames[0].Function != "main" {
			t.Errorf("frame[0] = %+v, want app.py:main", frames[0])
		}
	})

	t.Run("js stack", func(t *testing.T) {
		t.Parallel()
		input := `Error: something failed
    at processRequest (server.js:42:10)
    at handleRoute (router.js:15:5)`
		frames := parseStackFrames(input)
		if len(frames) != 2 {
			t.Fatalf("got %d frames, want 2", len(frames))
		}
		if frames[0].File != "server.js" || frames[0].Function != "processRequest" {
			t.Errorf("frame[0] = %+v, want server.js:processRequest", frames[0])
		}
	})

	t.Run("empty", func(t *testing.T) {
		t.Parallel()
		frames := parseStackFrames("just an error message")
		if len(frames) != 0 {
			t.Errorf("got %d frames, want 0", len(frames))
		}
	})
}

func TestMatchCompilePattern(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"undefined", "undefined: myFunc", true},
		{"unused import", `imported and not used: "fmt"`, true},
		{"unused var", "x declared and not used", true},
		{"missing return", "missing return at end of function", true},
		{"syntax error", "syntax error: unexpected }, expecting )", true},
		{"no match", "everything is fine", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := matchCompilePattern(tt.input)
			if (got != "") != tt.want {
				t.Errorf("matchCompilePattern(%q) = %q, want non-empty=%v", tt.input, got, tt.want)
			}
		})
	}
}

func TestExtractSig(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"error line", "some output\nerror: something failed\nmore output", "error: something failed"},
		{"first line fallback", "just a message\nno indicators", "just a message"},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := extractSig(tt.input)
			if got != tt.want {
				t.Errorf("extractSig() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBuildActions(t *testing.T) {
	t.Parallel()

	t.Run("edit mismatch", func(t *testing.T) {
		t.Parallel()
		d := &diagnosis{FailureType: "edit_mismatch"}
		actions := buildActions(d, "main.go")
		if len(actions) < 2 {
			t.Errorf("got %d actions, want >= 2", len(actions))
		}
	})

	t.Run("compile error with location", func(t *testing.T) {
		t.Parallel()
		d := &diagnosis{FailureType: "compile_error", Location: "main.go:10"}
		actions := buildActions(d, "main.go")
		if len(actions) < 2 {
			t.Errorf("got %d actions, want >= 2", len(actions))
		}
	})
}
