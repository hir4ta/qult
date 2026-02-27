package hookhandler

import (
	"encoding/json"
	"testing"
)

func TestCheckGoUncheckedError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"discarded error", `_ = sdb.SetContext("key", "val")`, true},
		{"handled error", `if err := sdb.SetContext("key", "val"); err != nil {`, false},
		{"comment about errors", `// we discard errors here`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkGoUncheckedError("test.go", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkGoUncheckedError(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckGoDebugPrint(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		filePath string
		content  string
		want     bool
	}{
		{"println in source", "main.go", `fmt.Println("debug")`, true},
		{"printf in source", "handler.go", `fmt.Printf("val: %d", x)`, true},
		{"println in test", "main_test.go", `fmt.Println("debug")`, false},
		{"no debug", "main.go", `log.Info("starting")`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkGoDebugPrint(tt.filePath, tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkGoDebugPrint(%q, %q) = %q, wantMatch=%v", tt.filePath, tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckTODOWithoutTicket(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"bare todo", "// TODO fix this later", true},
		{"todo with ticket", "// TODO(AUTH-123) fix this later", false},
		{"todo with colon ticket", "// TODO: AUTH-456 handle edge case", false},
		{"no todo", "// handle edge case", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkTODOWithoutTicket("test.go", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkTODOWithoutTicket(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckPyBareExcept(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"bare except", "except:", true},
		{"typed except", "except ValueError:", false},
		{"except as", "except Exception as e:", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkPyBareExcept("test.py", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkPyBareExcept(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckJSConsoleLog(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		filePath string
		content  string
		want     bool
	}{
		{"console.log in source", "app.js", `console.log("debug")`, true},
		{"console.log in test", "app.test.js", `console.log("debug")`, false},
		{"console.log in spec", "app.spec.ts", `console.log("debug")`, false},
		{"no console", "app.js", `logger.info("debug")`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkJSConsoleLog(tt.filePath, tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkJSConsoleLog(%q, %q) = %q, wantMatch=%v", tt.filePath, tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckHardcodedSecret(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"password literal", `password = "my_super_secret_123"`, true},
		{"api key", `api_key: "sk-1234567890abcdef"`, true},
		{"bearer token", `Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`, true},
		{"env var", `password = os.Getenv("DB_PASSWORD")`, false},
		{"short value", `api_key = "short"`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkHardcodedSecret("config.go", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkHardcodedSecret(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestExtractWriteContent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input json.RawMessage
		want  string
	}{
		{
			"edit tool",
			json.RawMessage(`{"file_path":"/a.go","old_string":"foo","new_string":"bar"}`),
			"bar",
		},
		{
			"write tool",
			json.RawMessage(`{"file_path":"/a.go","content":"package main"}`),
			"package main",
		},
		{
			"empty",
			json.RawMessage(`{"file_path":"/a.go"}`),
			"",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := extractWriteContent(tt.input)
			if got != tt.want {
				t.Errorf("extractWriteContent() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFileExtFromPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		path string
		want string
	}{
		{"/src/main.go", "go"},
		{"/src/app.py", "py"},
		{"/src/app.tsx", "js"},
		{"/src/app.ts", "js"},
		{"/src/app.jsx", "js"},
		{"/src/app.js", "js"},
		{"/Makefile", ""},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			t.Parallel()
			got := fileExtFromPath(tt.path)
			if got != tt.want {
				t.Errorf("fileExtFromPath(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestCheckCommandInjection(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"python os.system concat", `os.system("rm " + user_input)`, true},
		{"python subprocess concat", `subprocess.run("echo " + msg)`, true},
		{"python subprocess fstring", `subprocess.run(f"echo {msg}")`, true},
		{"go exec.Command concat", `exec.Command("sh " + cmd)`, true},
		{"node child_process concat", `child_process.exec("ls " + dir)`, true},
		{"template literal injection", `exec("SELECT " + "${val}")`, true},
		{"safe parameterized", `subprocess.run(["echo", msg])`, false},
		{"safe exec.Command", `exec.Command("ls", "-la")`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkCommandInjection("test.py", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkCommandInjection(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckWeakCrypto(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"go crypto/md5", `import "crypto/md5"`, true},
		{"go crypto/sha1", `import "crypto/sha1"`, true},
		{"python hashlib.md5", `hashlib.md5(data)`, true},
		{"python hashlib.sha1", `hashlib.sha1(data)`, true},
		{"node createHash md5", `createHash("md5")`, true},
		{"node createHash sha1", `createHash('sha1')`, true},
		{"java MD5", `MessageDigest.getInstance("MD5")`, true},
		{"safe sha256", `import "crypto/sha256"`, false},
		{"safe hashlib sha256", `hashlib.sha256(data)`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkWeakCrypto("test.go", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkWeakCrypto(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestGoASTCheck_TypeAssertion(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{
			"bare type assertion",
			`package main
func foo(v interface{}) {
	s := v.(string)
	_ = s
}`,
			true,
		},
		{
			"comma-ok type assertion",
			`package main
func foo(v interface{}) {
	s, ok := v.(string)
	_ = s
	_ = ok
}`,
			false,
		},
		{
			"type switch",
			`package main
func foo(v interface{}) {
	switch v.(type) {
	case string:
	}
}`,
			false,
		},
		{
			"test file skipped",
			`package main
func foo(v interface{}) {
	s := v.(string)
	_ = s
}`,
			false, // test file is skipped
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			filePath := "pkg.go"
			if tt.name == "test file skipped" {
				filePath = "pkg_test.go"
			}
			got := GoASTCheck(filePath, tt.content)
			if (got != "") != tt.want {
				t.Errorf("GoASTCheck(%q) = %q, wantMatch=%v", tt.name, got, tt.want)
			}
		})
	}
}

func TestCheckSSRF(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"python requests.get", `requests.get(url)`, true},
		{"go http.Get", `http.Get(target)`, true},
		{"js fetch", `fetch(userURL)`, true},
		{"safe literal url", `requests.get("https://example.com")`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkSSRF("test.py", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkSSRF(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckPathTraversal(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"python open concat", `open("/data/" + user_input)`, true},
		{"go filepath.Join", `filepath.Join(baseDir, userPath)`, true},
		{"sanitized", `filepath.Join(baseDir, filepath.Clean(userPath))`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkPathTraversal("test.go", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkPathTraversal(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckRegexDoS(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"nested quantifier", `re.Compile("(a+)+b")`, true},
		{"safe pattern", `re.Compile("[a-z]+")`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkRegexDoS("test.py", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkRegexDoS(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckUnsafeDeserialization(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"pickle.load", `data = pickle.load(f)`, true},
		{"yaml.load", `config = yaml.load(data)`, true},
		{"yaml.safe_load", `config = yaml.safe_load(data)`, false},
		{"json.load", `data = json.load(f)`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkUnsafeDeserialization("test.py", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkUnsafeDeserialization(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckGoUnclosedResource(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"unclosed file", `f, err := os.Open("data.txt")
if err != nil { return err }
// no close`, true},
		{"closed file", `f, err := os.Open("data.txt")
if err != nil { return err }
defer f.Close()`, false},
		{"test file", `f, err := os.Open("data.txt")`, false}, // test file excluded
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			filePath := "main.go"
			if tt.name == "test file" {
				filePath = "main_test.go"
			}
			got := checkGoUnclosedResource(filePath, tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkGoUnclosedResource(%q) = %q, wantMatch=%v", tt.name, got, tt.want)
			}
		})
	}
}

func TestCheckGoContextBackground(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"bare background", `ctx := context.Background()
db.QueryContext(ctx, query)`, true},
		{"with timeout", `ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)`, false},
		{"in main", `func main() {
ctx := context.Background()
}`, false},
		{"test file", `ctx := context.Background()`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			filePath := "handler.go"
			if tt.name == "test file" {
				filePath = "handler_test.go"
			}
			got := checkGoContextBackground(filePath, tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkGoContextBackground(%q) = %q, wantMatch=%v", tt.name, got, tt.want)
			}
		})
	}
}

func TestCheckPyPrintDebug(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		filePath string
		content  string
		want     bool
	}{
		{"print in source", "app.py", `print("debug")`, true},
		{"print in test", "test_app.py", `print("debug")`, false},
		{"no print", "app.py", `logging.info("debug")`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkPyPrintDebug(tt.filePath, tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkPyPrintDebug(%q, %q) = %q, wantMatch=%v", tt.filePath, tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckPyPickleUntrusted(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"pickle.load", `data = pickle.load(f)`, true},
		{"pickle.loads", `obj = pickle.loads(raw)`, true},
		{"json.load", `data = json.load(f)`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkPyPickleUntrusted("app.py", tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkPyPickleUntrusted(%q) = %q, wantMatch=%v", tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckRustPanicOutsideTest(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		filePath string
		content  string
		want     bool
	}{
		{"panic in source", "lib.rs", `panic!("something went wrong")`, true},
		{"panic in test", "lib_test.rs", `panic!("expected")`, false},
		{"panic in cfg test", "lib.rs", `#[cfg(test)] panic!("ok")`, false},
		{"no panic", "lib.rs", `eprintln!("error")`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkRustPanicOutsideTest(tt.filePath, tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkRustPanicOutsideTest(%q, %q) = %q, wantMatch=%v", tt.filePath, tt.content, got, tt.want)
			}
		})
	}
}

func TestCheckJSFloatingPromise(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		filePath string
		content  string
		want     bool
	}{
		{"floating promise", "app.js", "async function run() {\n  fetchData();\n}\n", true},
		{"awaited promise", "app.js", "async function run() {\n  await fetchData();\n}\n", false},
		{"with then", "app.js", "async function run() {\n  fetchData().then(handleResult);\n}\n", false},
		{"assigned", "app.js", "async function run() {\n  const p = fetchData();\n}\n", false},
		{"test file excluded", "app.test.js", "async function run() {\n  fetchData();\n}\n", false},
		{"no async context", "app.js", "function run() {\n  doSomething();\n}\n", false},
		{"void prefix", "app.js", "async function run() {\n  void fetchData();\n}\n", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := checkJSFloatingPromise(tt.filePath, tt.content)
			if (got != "") != tt.want {
				t.Errorf("checkJSFloatingPromise(%q, ...) = %q, wantMatch=%v", tt.filePath, got, tt.want)
			}
		})
	}
}

func TestRunCodeHeuristics_Integration(t *testing.T) {
	t.Parallel()

	// Go file with unchecked error.
	input := json.RawMessage(`{"file_path":"/src/main.go","new_string":"_ = db.Close()"}`)
	got := runCodeHeuristics("/src/main.go", input)
	if got == "" {
		t.Error("runCodeHeuristics() should detect unchecked error in .go file")
	}

	// Python file should not trigger Go checks.
	input = json.RawMessage(`{"file_path":"/src/app.py","new_string":"_ = db.Close()"}`)
	got = runCodeHeuristics("/src/app.py", input)
	if got != "" {
		t.Errorf("runCodeHeuristics() should not trigger Go check for .py file, got: %q", got)
	}
}
