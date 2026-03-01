package hookhandler

import "testing"

func TestIsGoTestFailure(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		output string
		want   bool
	}{
		{
			name:   "passing package",
			output: "ok  \tgithub.com/foo/bar\t0.5s",
			want:   false,
		},
		{
			name:   "individual test failure",
			output: "--- FAIL: TestFoo (0.00s)\n    foo_test.go:10: expected 1, got 2\nFAIL\tgithub.com/foo/bar\t0.5s",
			want:   true,
		},
		{
			name:   "package failure line",
			output: "FAIL\tgithub.com/foo/bar\t1.2s",
			want:   true,
		},
		{
			name:   "log containing error keyword",
			output: "[alfred] seed patterns: store: insert seed pattern \"undefined: FooBar\": error\nok  \tgithub.com/foo/bar\t0.7s",
			want:   false,
		},
		{
			name:   "log containing FAIL keyword in non-test context",
			output: "[alfred] SNR: 0.00 (3 suggestions)\nFAILED to insert\nok  \tgithub.com/foo/bar\t0.7s",
			want:   false,
		},
		{
			name:   "empty output",
			output: "",
			want:   false,
		},
		{
			name:   "multiple packages with one failure",
			output: "ok  \tgithub.com/foo/a\t0.1s\n--- FAIL: TestBar (0.01s)\nFAIL\tgithub.com/foo/b\t0.3s",
			want:   true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := isGoTestFailure(tc.output)
			if got != tc.want {
				t.Errorf("isGoTestFailure(%q) = %v, want %v", tc.output, got, tc.want)
			}
		})
	}
}

func TestIsBuildFailure(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		output string
		want   bool
	}{
		{
			name:   "empty output (success)",
			output: "",
			want:   false,
		},
		{
			name:   "go compiler error",
			output: "./main.go:10:5: undefined: FooBar",
			want:   true,
		},
		{
			name:   "multiple compiler errors",
			output: "./main.go:10:5: undefined: Foo\n./main.go:15:2: too many arguments",
			want:   true,
		},
		{
			name:   "compilation failed message",
			output: "compilation failed",
			want:   true,
		},
		{
			name:   "build failed message",
			output: "build failed",
			want:   true,
		},
		{
			name:   "log containing error but not build failure",
			output: "[alfred] store: insert seed pattern \"undefined: FooBar\": error",
			want:   false,
		},
		{
			name:   "warning output (not failure)",
			output: "# github.com/foo/bar\nvet: some warning",
			want:   false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := isBuildFailure(tc.output)
			if got != tc.want {
				t.Errorf("isBuildFailure(%q) = %v, want %v", tc.output, got, tc.want)
			}
		})
	}
}

func TestClassifyFailure_BashPriority(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		errorMsg string
		want     string
	}{
		{
			name:     "test failure with undefined in logs",
			errorMsg: "--- FAIL: TestFoo\nundefined: some seed pattern log",
			want:     failTestFailure,
		},
		{
			name:     "pure compile error",
			errorMsg: "./main.go:10:5: undefined: FooBar",
			want:     failCompileError,
		},
		{
			name:     "test failure only",
			errorMsg: "FAIL\tgithub.com/foo/bar\t0.5s",
			want:     failTestFailure,
		},
		{
			name:     "generic bash error",
			errorMsg: "command timed out",
			want:     failBashError,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := classifyFailure("Bash", tc.errorMsg)
			if got != tc.want {
				t.Errorf("classifyFailure(Bash, %q) = %q, want %q", tc.errorMsg, got, tc.want)
			}
		})
	}
}
