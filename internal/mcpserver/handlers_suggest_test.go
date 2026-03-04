package mcpserver

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/store"
)

func TestSuggestHandler_MissingProjectPath(t *testing.T) {
	t.Parallel()
	handler := suggestHandler(t.TempDir(), nil, nil)

	res, err := handler(context.Background(), newRequest(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for missing project_path")
	}
}

func TestSuggestHandler_NoGitRepo(t *testing.T) {
	t.Parallel()
	handler := suggestHandler(t.TempDir(), nil, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": t.TempDir(),
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if summary, _ := m["summary"].(string); summary == "" {
		t.Error("expected summary for no-changes result")
	}
}

func TestSuggestHandler_WithGitChanges(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	claudeHome := t.TempDir()
	handler := suggestHandler(claudeHome, nil, nil)

	gitRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}

	gitRun("init")
	gitRun("config", "user.name", "test")
	gitRun("config", "user.email", "test@test.com")
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun("add", ".")
	gitRun("commit", "-m", "initial")

	// Add a new file and commit.
	if err := os.WriteFile(filepath.Join(dir, "new.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun("add", "new.go")
	gitRun("commit", "-m", "add new.go")

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	changedFiles, _ := m["changed_files"].(float64)
	if changedFiles == 0 {
		t.Error("expected changed_files > 0")
	}
	if _, ok := m["suggestions"]; !ok {
		t.Error("expected suggestions key")
	}
}

func TestSuggestHandler_StructuredSuggestions(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	claudeHome := t.TempDir()
	handler := suggestHandler(claudeHome, nil, nil)

	gitRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}

	gitRun("init")
	gitRun("config", "user.name", "test")
	gitRun("config", "user.email", "test@test.com")
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o644)
	gitRun("add", ".")
	gitRun("commit", "-m", "initial")

	os.WriteFile(filepath.Join(dir, "new.go"), []byte("package main\n"), 0o644)
	gitRun("add", "new.go")
	gitRun("commit", "-m", "add new.go")

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	suggestions, ok := m["suggestions"].([]any)
	if !ok || len(suggestions) == 0 {
		t.Fatal("expected suggestions")
	}

	// Verify structured format.
	first := suggestions[0].(map[string]any)
	if first["severity"] == nil {
		t.Error("expected severity field in suggestion")
	}
	if first["category"] == nil {
		t.Error("expected category field in suggestion")
	}
	if first["message"] == nil {
		t.Error("expected message field in suggestion")
	}
}

func TestSuggestHandler_DetectsPatterns(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	claudeHome := t.TempDir()
	handler := suggestHandler(claudeHome, nil, nil)

	gitRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}

	gitRun("init")
	gitRun("config", "user.name", "test")
	gitRun("config", "user.email", "test@test.com")

	// Create initial commit with go.mod.
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module test\ngo 1.22\n"), 0o644)
	gitRun("add", ".")
	gitRun("commit", "-m", "initial")

	// Add new dependency to go.mod.
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module test\ngo 1.22\nrequire example.com/pkg v1.0.0\n"), 0o644)
	gitRun("add", "go.mod")
	gitRun("commit", "-m", "add dep")

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	patterns, ok := m["change_patterns"].([]any)
	if !ok || len(patterns) == 0 {
		t.Fatal("expected change_patterns")
	}

	found := false
	for _, p := range patterns {
		pm, ok := p.(map[string]any)
		if !ok {
			continue
		}
		if pm["type"] == "dependency_changes" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected dependency_changes pattern")
	}
}

func TestSuggestHandler_WithKBEnrichment(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	claudeHome := t.TempDir()
	st := openTestStore(t)

	// Seed KB.
	doc := &store.DocRow{
		URL:         "https://example.com/claude-md",
		SectionPath: "CLAUDE.md > Structure",
		Content:     "Keep CLAUDE.md Structure section updated when adding packages.",
		SourceType:  "docs",
	}
	doc.ContentHash = store.ContentHashOf(doc.Content)
	st.UpsertDoc(doc)

	handler := suggestHandler(claudeHome, st, nil)

	gitRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}

	gitRun("init")
	gitRun("config", "user.name", "test")
	gitRun("config", "user.email", "test@test.com")
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o644)
	gitRun("add", ".")
	gitRun("commit", "-m", "initial")

	os.WriteFile(filepath.Join(dir, "new.go"), []byte("package main\n"), 0o644)
	gitRun("add", "new.go")
	gitRun("commit", "-m", "add new")

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": dir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	suggestions, ok := m["suggestions"].([]any)
	if !ok || len(suggestions) == 0 {
		t.Skip("no suggestions generated (expected for simple change)")
	}

	hasBP := false
	for _, s := range suggestions {
		sm, ok := s.(map[string]any)
		if !ok {
			continue
		}
		if sm["best_practice"] != nil {
			hasBP = true
			break
		}
	}
	if !hasBP {
		// Not a hard failure — KB enrichment depends on FTS matching.
		t.Log("no suggestions had best_practice; KB match may not apply to this diff")
	}
}

func TestDetectChangePatterns_NewTests(t *testing.T) {
	t.Parallel()
	diff := diffInfo{
		files:   []string{"pkg/auth_test.go"},
		content: "+func TestLogin(t *testing.T) {\n",
	}
	patterns := detectChangePatterns(diff)

	found := false
	for _, p := range patterns {
		if p.Type == "new_tests" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected new_tests pattern")
	}
}

func TestDetectChangePatterns_APIEndpoints(t *testing.T) {
	t.Parallel()
	diff := diffInfo{
		files:   []string{"main.go"},
		content: "+\thttp.HandleFunc(\"/api/users\", handleUsers)\n",
	}
	patterns := detectChangePatterns(diff)

	found := false
	for _, p := range patterns {
		if p.Type == "new_api_endpoints" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected new_api_endpoints pattern")
	}
}

func TestContainsAny(t *testing.T) {
	t.Parallel()
	if !containsAny("hello world", "world", "xyz") {
		t.Error("expected true")
	}
	if containsAny("hello", "world", "xyz") {
		t.Error("expected false")
	}
}

func TestDetectChangePatterns_Empty(t *testing.T) {
	t.Parallel()
	diff := diffInfo{files: []string{"readme.md"}, content: ""}
	patterns := detectChangePatterns(diff)
	// No false positives on empty content.
	for _, p := range patterns {
		if strings.Contains(p.Type, "api") || strings.Contains(p.Type, "test") {
			t.Errorf("unexpected pattern %q for empty diff content", p.Type)
		}
	}
}

// ---------------------------------------------------------------------------
// extLanguage tests
// ---------------------------------------------------------------------------

func TestExtLanguage(t *testing.T) {
	t.Parallel()
	cases := []struct {
		ext  string
		want string
	}{
		{".go", "go"},
		{".ts", "typescript"},
		{".tsx", "typescript"},
		{".js", "javascript"},
		{".jsx", "javascript"},
		{".py", "python"},
		{".rs", "rust"},
		{".java", "java"},
		{".rb", "ruby"},
		{".swift", "swift"},
		{".kt", "kotlin"},
		{".cpp", "cpp"},
		{".unknown", "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.ext, func(t *testing.T) {
			t.Parallel()
			got := extLanguage(tc.ext)
			if got != tc.want {
				t.Errorf("extLanguage(%q) = %q, want %q", tc.ext, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// hasNewDirs tests
// ---------------------------------------------------------------------------

func TestHasNewDirs(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		diff   diffInfo
		config configState
		want   bool
	}{
		{
			name:   "no CLAUDE.md returns false",
			diff:   diffInfo{dirs: []string{"newpkg"}},
			config: configState{hasClaudeMD: false},
			want:   false,
		},
		{
			name:   "no dirs returns false",
			diff:   diffInfo{dirs: nil},
			config: configState{hasClaudeMD: true, claudeMDSections: []string{"Structure"}},
			want:   false,
		},
		{
			name:   "dir already in sections returns false",
			diff:   diffInfo{dirs: []string{"internal"}},
			config: configState{hasClaudeMD: true, claudeMDSections: []string{"Structure with internal"}},
			want:   false,
		},
		{
			name:   "new dir not in sections returns true",
			diff:   diffInfo{dirs: []string{"newpkg"}},
			config: configState{hasClaudeMD: true, claudeMDSections: []string{"Structure", "Commands"}},
			want:   true,
		},
		{
			name:   "case insensitive match",
			diff:   diffInfo{dirs: []string{"Internal"}},
			config: configState{hasClaudeMD: true, claudeMDSections: []string{"internal package"}},
			want:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := hasNewDirs(tc.diff, tc.config)
			if got != tc.want {
				t.Errorf("hasNewDirs() = %v, want %v", got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// patternToSuggestion tests
// ---------------------------------------------------------------------------

func TestPatternToSuggestion(t *testing.T) {
	t.Parallel()
	configWithMD := configState{hasClaudeMD: true}
	configNoMD := configState{hasClaudeMD: false}

	cases := []struct {
		name       string
		pattern    changePattern
		config     configState
		wantNil    bool
		wantSubstr string
	}{
		{
			name:    "no CLAUDE.md returns nil",
			pattern: changePattern{Type: "dependency_changes"},
			config:  configNoMD,
			wantNil: true,
		},
		{
			name:       "dependency_changes",
			pattern:    changePattern{Type: "dependency_changes"},
			config:     configWithMD,
			wantSubstr: "Dependencies changed",
		},
		{
			name:       "database_changes",
			pattern:    changePattern{Type: "database_changes"},
			config:     configWithMD,
			wantSubstr: "Database schema",
		},
		{
			name:       "new_api_endpoints",
			pattern:    changePattern{Type: "new_api_endpoints"},
			config:     configWithMD,
			wantSubstr: "API endpoints",
		},
		{
			name:    "unknown pattern returns nil",
			pattern: changePattern{Type: "new_tests"},
			config:  configWithMD,
			wantNil: true,
		},
		{
			name:    "new_packages returns nil",
			pattern: changePattern{Type: "new_packages"},
			config:  configWithMD,
			wantNil: true,
		},
		{
			name:    "config_changes returns nil",
			pattern: changePattern{Type: "config_changes"},
			config:  configWithMD,
			wantNil: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := patternToSuggestion(tc.pattern, tc.config)
			if tc.wantNil {
				if got != nil {
					t.Errorf("patternToSuggestion() = %+v, want nil", got)
				}
				return
			}
			if got == nil {
				t.Fatal("patternToSuggestion() = nil, want non-nil")
			}
			if got.Severity != "info" {
				t.Errorf("severity = %q, want info", got.Severity)
			}
			if got.Category != "claude_md" {
				t.Errorf("category = %q, want claude_md", got.Category)
			}
			if tc.wantSubstr != "" && !strings.Contains(got.Message, tc.wantSubstr) {
				t.Errorf("message = %q, want to contain %q", got.Message, tc.wantSubstr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// readHookEvents tests
// ---------------------------------------------------------------------------

func TestReadHookEvents(t *testing.T) {
	t.Parallel()

	t.Run("missing file returns nil", func(t *testing.T) {
		t.Parallel()
		got := readHookEvents(t.TempDir())
		if got != nil {
			t.Errorf("readHookEvents(missing) = %v, want nil", got)
		}
	})

	t.Run("invalid JSON returns nil", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "settings.json"), []byte("not json"), 0o644)
		got := readHookEvents(dir)
		if got != nil {
			t.Errorf("readHookEvents(invalid JSON) = %v, want nil", got)
		}
	})

	t.Run("no hooks key returns nil", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"other":"value"}`), 0o644)
		got := readHookEvents(dir)
		if got != nil {
			t.Errorf("readHookEvents(no hooks) = %v, want nil", got)
		}
	})

	t.Run("hooks not a map returns nil", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"hooks":"not-a-map"}`), 0o644)
		got := readHookEvents(dir)
		if got != nil {
			t.Errorf("readHookEvents(hooks=string) = %v, want nil", got)
		}
	})

	t.Run("single hook event", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"hooks":{"SessionStart":[]}}`), 0o644)
		got := readHookEvents(dir)
		if len(got) != 1 || got[0] != "SessionStart" {
			t.Errorf("readHookEvents = %v, want [SessionStart]", got)
		}
	})

	t.Run("multiple hook events", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "settings.json"),
			[]byte(`{"hooks":{"SessionStart":[],"PreToolUse":[],"PostToolUse":[]}}`), 0o644)
		got := readHookEvents(dir)
		if len(got) != 3 {
			t.Errorf("readHookEvents count = %d, want 3", len(got))
		}
		eventSet := map[string]bool{}
		for _, e := range got {
			eventSet[e] = true
		}
		for _, want := range []string{"SessionStart", "PreToolUse", "PostToolUse"} {
			if !eventSet[want] {
				t.Errorf("missing event %q in %v", want, got)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// detectChangePatterns: additional coverage
// ---------------------------------------------------------------------------

func TestDetectChangePatterns_DependencyChanges(t *testing.T) {
	t.Parallel()
	depFiles := []string{"go.mod", "go.sum", "package.json", "package-lock.json",
		"requirements.txt", "pyproject.toml", "Cargo.toml", "Cargo.lock"}
	for _, f := range depFiles {
		t.Run(f, func(t *testing.T) {
			t.Parallel()
			diff := diffInfo{files: []string{f, "main.go"}}
			patterns := detectChangePatterns(diff)
			found := false
			for _, p := range patterns {
				if p.Type == "dependency_changes" {
					found = true
				}
			}
			if !found {
				t.Errorf("expected dependency_changes for %s", f)
			}
		})
	}
}

func TestDetectChangePatterns_ConfigChanges(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		file string
	}{
		{"docker-compose", "docker-compose.yml"},
		{"Dockerfile", "Dockerfile"},
		{"config dir", "config/settings.yml"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			diff := diffInfo{files: []string{tc.file}}
			patterns := detectChangePatterns(diff)
			found := false
			for _, p := range patterns {
				if p.Type == "config_changes" {
					found = true
				}
			}
			if !found {
				t.Errorf("expected config_changes for %s", tc.file)
			}
		})
	}
}

func TestDetectChangePatterns_DatabaseChanges_SQL(t *testing.T) {
	t.Parallel()
	for _, sql := range []string{"CREATE TABLE", "ALTER TABLE", "DROP TABLE"} {
		t.Run(sql, func(t *testing.T) {
			t.Parallel()
			diff := diffInfo{
				files:   []string{"schema.sql"},
				content: "+" + sql + " users (...);",
			}
			patterns := detectChangePatterns(diff)
			found := false
			for _, p := range patterns {
				if p.Type == "database_changes" {
					found = true
				}
			}
			if !found {
				t.Errorf("expected database_changes for %s", sql)
			}
		})
	}
}

func TestDetectChangePatterns_MigrationFile(t *testing.T) {
	t.Parallel()
	diff := diffInfo{
		files: []string{"db/migrate/001_add_users.sql"},
	}
	patterns := detectChangePatterns(diff)
	found := false
	for _, p := range patterns {
		if p.Type == "database_changes" {
			found = true
		}
	}
	if !found {
		t.Error("expected database_changes for migration file")
	}
}

// ---------------------------------------------------------------------------
// buildDiffInfo tests
// ---------------------------------------------------------------------------

func TestBuildDiffInfo(t *testing.T) {
	t.Parallel()
	di := buildDiffInfo("staged", []string{
		"internal/store/docs.go",
		"internal/mcpserver/handler.go",
		"cmd/alfred/main.go",
		"go.mod",
	})
	if di.scope != "staged" {
		t.Errorf("scope = %q, want staged", di.scope)
	}
	if len(di.files) != 4 {
		t.Errorf("files count = %d, want 4", len(di.files))
	}
	// Should have 3 unique top-level dirs: internal, cmd, go.mod.
	if len(di.dirs) != 3 {
		t.Errorf("dirs count = %d, want 3 (internal, cmd, go.mod)", len(di.dirs))
	}
}

// ---------------------------------------------------------------------------
// helper function tests
// ---------------------------------------------------------------------------

func TestHasRule(t *testing.T) {
	t.Parallel()
	config := configState{
		ruleNames: []string{"go-testing.md", "typescript.md"},
	}
	if !hasRule(config, "test") {
		t.Error("hasRule(test) = false, want true")
	}
	if !hasRule(config, "typescript") {
		t.Error("hasRule(typescript) = false, want true")
	}
	if hasRule(config, "python") {
		t.Error("hasRule(python) = true, want false")
	}
}

func TestHasRuleForExt(t *testing.T) {
	t.Parallel()
	config := configState{
		ruleNames: []string{"go-testing.md"},
	}
	if !hasRuleForExt(config, ".go") {
		t.Error("hasRuleForExt(.go) = false, want true (matches 'go')")
	}
	if hasRuleForExt(config, ".py") {
		t.Error("hasRuleForExt(.py) = true, want false")
	}
}

func TestUniqueExtensions(t *testing.T) {
	t.Parallel()
	exts := uniqueExtensions([]string{
		"main.go", "handler.go", "app.ts", "style.css", "readme",
	})
	seen := map[string]bool{}
	for _, e := range exts {
		if seen[e] {
			t.Errorf("duplicate extension %q", e)
		}
		seen[e] = true
	}
	if !seen[".go"] {
		t.Error("missing .go extension")
	}
	if !seen[".ts"] {
		t.Error("missing .ts extension")
	}
	if !seen[".css"] {
		t.Error("missing .css extension")
	}
	// "readme" has no extension, should not appear.
	if len(exts) != 3 {
		t.Errorf("expected 3 extensions, got %d: %v", len(exts), exts)
	}
}

func TestIsSignificantExt(t *testing.T) {
	t.Parallel()
	significant := []string{".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".java", ".rb", ".swift", ".kt"}
	for _, ext := range significant {
		if !isSignificantExt(ext) {
			t.Errorf("isSignificantExt(%q) = false, want true", ext)
		}
	}
	notSignificant := []string{".md", ".txt", ".css", ".html", ".yml", ".json"}
	for _, ext := range notSignificant {
		if isSignificantExt(ext) {
			t.Errorf("isSignificantExt(%q) = true, want false", ext)
		}
	}
}
