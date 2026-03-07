package mcpserver

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

const maxDiffBytes = 32 * 1024 // 32 KB limit for diff content

// suggestHandler returns a handler that analyzes recent code changes and
// suggests .claude/ configuration updates with KB cross-reference.
func suggestHandler(claudeHome string, st *store.Store, _ *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")
		if projectPath == "" {
			return mcp.NewToolResultError("project_path is required"), nil
		}

		// Collect git diff information (file names + content).
		diff := collectDiff(projectPath)
		if diff.err != "" {
			return mcp.NewToolResultError(diff.err), nil
		}
		if len(diff.files) == 0 {
			return marshalResult(map[string]any{
				"project_path": projectPath,
				"suggestions":  []Suggestion{},
				"summary":      "no recent changes detected",
			})
		}

		// Analyze current .claude/ config.
		config := analyzeConfig(projectPath, claudeHome)

		// Detect change patterns from diff content.
		patterns := detectChangePatterns(diff)

		// Generate suggestions with KB cross-reference.
		suggestions := generateSuggestSuggestions(diff, config, patterns, st)

		result := map[string]any{
			"project_path":     projectPath,
			"changed_files":    len(diff.files),
			"diff_scope":       diff.scope,
			"suggestions":      suggestions,
			"suggestion_count": len(suggestions),
		}

		if len(patterns) > 0 {
			result["change_patterns"] = patterns
		}
		if len(suggestions) == 0 {
			result["summary"] = "no configuration changes suggested for the recent diff"
		}

		return marshalResult(result)
	}
}

// ---------------------------------------------------------------------------
// Git diff collection
// ---------------------------------------------------------------------------

type diffInfo struct {
	scope   string   // "staged", "unstaged", or "recent_commits"
	files   []string // changed file paths
	dirs    []string // unique top-level directories touched
	content string   // actual diff content (truncated to maxDiffBytes)
	err     string
}

func collectDiff(projectPath string) diffInfo {
	// Check if we're in a git repo first.
	cmd := exec.Command("git", "rev-parse", "--is-inside-work-tree")
	cmd.Dir = projectPath
	if err := cmd.Run(); err != nil {
		return diffInfo{} // not a git repo — no changes
	}

	// Try staged changes first, then unstaged, then recent commits.
	if files := gitDiffFiles(projectPath, "--cached"); len(files) > 0 {
		di := buildDiffInfo("staged", files)
		di.content = gitDiffContent(projectPath, "--cached")
		return di
	}
	if files := gitDiffFiles(projectPath); len(files) > 0 {
		di := buildDiffInfo("unstaged", files)
		di.content = gitDiffContent(projectPath)
		return di
	}
	if files := gitLogFiles(projectPath, 10); len(files) > 0 {
		di := buildDiffInfo("recent_commits", files)
		di.content = gitLogContent(projectPath, 10)
		return di
	}
	return diffInfo{}
}

func gitDiffFiles(projectPath string, args ...string) []string {
	cmdArgs := append([]string{"diff", "--name-only"}, args...)
	cmd := exec.Command("git", cmdArgs...)
	cmd.Dir = projectPath
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var files []string
	for line := range strings.SplitSeq(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			files = append(files, line)
		}
	}
	return files
}

// gitLogFiles returns file paths changed in the last n commits.
func gitLogFiles(projectPath string, n int) []string {
	cmd := exec.Command("git", "log", "--name-only", "--format=", "-"+strconv.Itoa(n))
	cmd.Dir = projectPath
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var files []string
	for line := range strings.SplitSeq(strings.TrimSpace(string(out)), "\n") {
		if line != "" && !seen[line] {
			seen[line] = true
			files = append(files, line)
		}
	}
	return files
}

func gitDiffContent(projectPath string, args ...string) string {
	cmdArgs := append([]string{"diff"}, args...)
	cmd := exec.Command("git", cmdArgs...)
	cmd.Dir = projectPath
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	if len(out) > maxDiffBytes {
		return string(out[:maxDiffBytes]) + "\n[diff truncated at 32KB]"
	}
	return string(out)
}

func gitLogContent(projectPath string, n int) string {
	cmd := exec.Command("git", "log", "-p", "--format=format:%H", "-"+strconv.Itoa(n))
	cmd.Dir = projectPath
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	if len(out) > maxDiffBytes {
		return string(out[:maxDiffBytes]) + "\n[diff truncated at 32KB]"
	}
	return string(out)
}

func buildDiffInfo(scope string, files []string) diffInfo {
	dirSet := map[string]bool{}
	for _, f := range files {
		top := strings.SplitN(f, "/", 2)[0]
		dirSet[top] = true
	}
	dirs := make([]string, 0, len(dirSet))
	for d := range dirSet {
		dirs = append(dirs, d)
	}
	return diffInfo{scope: scope, files: files, dirs: dirs}
}

// ---------------------------------------------------------------------------
// Config analysis
// ---------------------------------------------------------------------------

type configState struct {
	hasClaudeMD bool
	claudeMDSections []string
	skillNames  []string
	ruleNames   []string
	hookEvents  []string
	hasMCP      bool
}

func analyzeConfig(projectPath, claudeHome string) configState {
	var cs configState

	// CLAUDE.md
	if data, err := os.ReadFile(filepath.Join(projectPath, "CLAUDE.md")); err == nil {
		cs.hasClaudeMD = true
		cs.claudeMDSections = extractH2Sections(string(data))
	}

	// Skills
	if entries, err := os.ReadDir(filepath.Join(projectPath, ".claude", "skills")); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				cs.skillNames = append(cs.skillNames, e.Name())
			}
		}
	}

	// Rules
	if entries, err := os.ReadDir(filepath.Join(projectPath, ".claude", "rules")); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				cs.ruleNames = append(cs.ruleNames, e.Name())
			}
		}
	}

	// Hooks
	cs.hookEvents = readHookEvents(claudeHome)

	// MCP
	if _, err := os.Stat(filepath.Join(projectPath, ".mcp.json")); err == nil {
		cs.hasMCP = true
	}

	return cs
}

func readHookEvents(claudeHome string) []string {
	data, err := os.ReadFile(filepath.Join(claudeHome, "settings.json"))
	if err != nil {
		return nil
	}
	// Quick extraction without full JSON parse.
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil
	}
	hooks, ok := m["hooks"].(map[string]any)
	if !ok {
		return nil
	}
	events := make([]string, 0, len(hooks))
	for ev := range hooks {
		events = append(events, ev)
	}
	return events
}

// ---------------------------------------------------------------------------
// Change pattern detection
// ---------------------------------------------------------------------------

type changePattern struct {
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Files       []string `json:"files,omitempty"`
}

func detectChangePatterns(diff diffInfo) []changePattern {
	var patterns []changePattern

	// 1. New API endpoints.
	if containsAny(diff.content,
		"http.HandleFunc", "http.Handle(", "mux.Handle",
		"router.Handle", "gin.GET", "gin.POST",
		"app.get(", "app.post(", "app.put(",
		"@app.route", "@router.",
		"e.GET(", "e.POST(") {
		patterns = append(patterns, changePattern{
			Type:        "new_api_endpoints",
			Description: "New API endpoints or routes detected in diff",
		})
	}

	// 2. Dependency changes.
	depFiles := []string{"go.mod", "go.sum", "package.json", "package-lock.json",
		"requirements.txt", "pyproject.toml", "Cargo.toml", "Cargo.lock"}
outer:
	for _, f := range diff.files {
		for _, dep := range depFiles {
			if f == dep {
				patterns = append(patterns, changePattern{
					Type:        "dependency_changes",
					Description: "Project dependencies changed",
					Files:       []string{f},
				})
				break outer
			}
		}
	}

	// 3. New test functions.
	if containsAny(diff.content,
		"+func Test", "+\tfunc Test",
		"+describe(", "+it(",
		"+def test_", "+class Test") {
		patterns = append(patterns, changePattern{
			Type:        "new_tests",
			Description: "New test functions added",
		})
	}

	// 4. Config file changes (dotenv, docker, config dirs).
	for _, f := range diff.files {
		base := filepath.Base(f)
		isDotEnv := len(base) > 1 && base[0] == '.' && strings.Contains(strings.ToLower(base[1:]), "env")
		isConfig := strings.Contains(f, "config") ||
			base == "docker-compose.yml" || base == "Dockerfile"
		if isDotEnv || isConfig {
			patterns = append(patterns, changePattern{
				Type:        "config_changes",
				Description: "Configuration files changed",
				Files:       []string{f},
			})
			break
		}
	}

	// 5. Database/migration changes.
	if containsAny(diff.content, "CREATE TABLE", "ALTER TABLE", "DROP TABLE") {
		patterns = append(patterns, changePattern{
			Type:        "database_changes",
			Description: "Database schema changes detected",
		})
	} else {
		for _, f := range diff.files {
			if strings.Contains(f, "migration") || strings.Contains(f, "migrate") {
				patterns = append(patterns, changePattern{
					Type:        "database_changes",
					Description: "Migration files changed",
					Files:       []string{f},
				})
				break
			}
		}
	}

	// 6. New packages/directories.
	newDirs := detectNewDirsInDiff(diff)
	if len(newDirs) > 0 {
		patterns = append(patterns, changePattern{
			Type:        "new_packages",
			Description: "New packages or directories added",
			Files:       newDirs,
		})
	}

	return patterns
}

// detectNewDirsInDiff finds new directories by checking for added file markers in diff.
func detectNewDirsInDiff(diff diffInfo) []string {
	newDirs := map[string]bool{}
	for _, f := range diff.files {
		parts := strings.SplitN(f, "/", 3)
		if len(parts) >= 2 {
			dir := parts[0] + "/" + parts[1]
			newDirs[dir] = true
		}
	}
	var result []string
	for dir := range newDirs {
		if strings.Contains(diff.content, "+++ b/"+dir) {
			result = append(result, dir)
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Suggestion generation with KB cross-reference
// ---------------------------------------------------------------------------

// suggestKBQueries maps pattern types to FTS5 queries.
var suggestKBQueries = map[string]string{
	"new_api_endpoints":  "CLAUDE.md API routes documentation structure",
	"dependency_changes": "CLAUDE.md dependencies stack section",
	"new_tests":          "rules testing conventions best practices",
	"config_changes":     "CLAUDE.md configuration environment setup",
	"database_changes":   "CLAUDE.md database schema migrations",
	"new_packages":       "CLAUDE.md structure packages organization",
}

func generateSuggestSuggestions(diff diffInfo, config configState, patterns []changePattern, st *store.Store) []Suggestion {
	var suggestions []Suggestion

	// Categorize changed files.
	var (
		configFiles []string
		testFiles   []string
		ciFiles     []string
		sourceFiles []string
	)

	for _, f := range diff.files {
		switch {
		case strings.HasPrefix(f, ".claude/"):
			configFiles = append(configFiles, f)
		case strings.Contains(f, "_test.go") || strings.HasPrefix(f, "test/") || strings.HasPrefix(f, "tests/"):
			testFiles = append(testFiles, f)
		case strings.HasPrefix(f, ".github/"):
			ciFiles = append(ciFiles, f)
		case !strings.HasSuffix(f, ".md"):
			sourceFiles = append(sourceFiles, f)
		}
	}

	// 1. CLAUDE.md checks.
	if !config.hasClaudeMD && len(sourceFiles) > 0 {
		suggestions = append(suggestions, Suggestion{
			Severity: "warning",
			Category: "claude_md",
			Message:  "Create CLAUDE.md -- source files changed but no CLAUDE.md exists to guide Claude Code",
		})
	}

	if config.hasClaudeMD {
		hasCmdSection := false
		for _, sec := range config.claudeMDSections {
			if strings.Contains(strings.ToLower(sec), "command") {
				hasCmdSection = true
				break
			}
		}

		if hasNewDirs(diff, config) {
			suggestions = append(suggestions, Suggestion{
				Severity: "info",
				Category: "claude_md",
				Message:  "Update CLAUDE.md ## Structure -- new directories detected in diff",
			})
		}

		if len(ciFiles) > 0 && hasCmdSection {
			suggestions = append(suggestions, Suggestion{
				Severity: "info",
				Category: "claude_md",
				Message:  "Review CLAUDE.md ## Commands -- CI workflow files changed",
			})
		}
	}

	// 2. Test pattern changes.
	if len(testFiles) > 0 && !hasRule(config, "test") {
		suggestions = append(suggestions, Suggestion{
			Severity: "info",
			Category: "rules",
			Message:  "Consider adding .claude/rules/ for testing conventions -- test files changed",
		})
	}

	// 3. .claude/ config files changed.
	for _, f := range configFiles {
		switch {
		case strings.Contains(f, "skills/"):
			suggestions = append(suggestions, Suggestion{
				Severity: "info",
				Category: "skills",
				Message:  "Skill file changed: " + f + " -- verify frontmatter (name, description) is complete",
				Affected: []string{f},
			})
		case strings.Contains(f, "rules/"):
			suggestions = append(suggestions, Suggestion{
				Severity: "info",
				Category: "rules",
				Message:  "Rule file changed: " + f + " -- verify rule is clear and actionable",
				Affected: []string{f},
			})
		}
	}

	// 4. New file types that might need rules.
	exts := uniqueExtensions(sourceFiles)
	for _, ext := range exts {
		if !hasRuleForExt(config, ext) && isSignificantExt(ext) {
			suggestions = append(suggestions, Suggestion{
				Severity: "info",
				Category: "rules",
				Message:  "New " + ext + " files detected -- consider adding .claude/rules/ for " + extLanguage(ext) + " conventions",
			})
		}
	}

	// 5. Pattern-based suggestions.
	for _, p := range patterns {
		if s := patternToSuggestion(p, config); s != nil {
			suggestions = append(suggestions, *s)
		}
	}

	// Enrich with KB best practices.
	enrichSuggestWithKB(suggestions, patterns, st)

	return suggestions
}

func patternToSuggestion(p changePattern, config configState) *Suggestion {
	if !config.hasClaudeMD {
		return nil
	}
	switch p.Type {
	case "dependency_changes":
		return &Suggestion{
			Severity: "info",
			Category: "claude_md",
			Message:  "Dependencies changed -- consider updating CLAUDE.md ## Stack",
		}
	case "database_changes":
		return &Suggestion{
			Severity: "info",
			Category: "claude_md",
			Message:  "Database schema or migrations changed -- update CLAUDE.md with schema info",
		}
	case "new_api_endpoints":
		return &Suggestion{
			Severity: "info",
			Category: "claude_md",
			Message:  "New API endpoints detected -- consider documenting in CLAUDE.md",
		}
	}
	return nil
}

// enrichSuggestWithKB attaches KB snippets based on change patterns and categories.
func enrichSuggestWithKB(suggestions []Suggestion, patterns []changePattern, st *store.Store) {
	if st == nil || len(suggestions) == 0 {
		return
	}

	cache := map[string]*KBSnippet{}

	// Query KB for each pattern type.
	for _, p := range patterns {
		q, ok := suggestKBQueries[p.Type]
		if !ok {
			continue
		}
		if _, cached := cache[p.Type]; cached {
			continue
		}
		if snippets := queryKB(st, q, 1); len(snippets) > 0 {
			cache[p.Type] = &snippets[0]
		}
	}

	// Query for common suggestion categories.
	categoryQueries := map[string]string{
		"claude_md": "CLAUDE.md best practices sections",
		"rules":     "rules coding standards configuration",
		"skills":    "skills configuration best practices",
	}
	for _, s := range suggestions {
		if _, ok := cache[s.Category]; ok {
			continue
		}
		if q, ok := categoryQueries[s.Category]; ok {
			if snippets := queryKB(st, q, 1); len(snippets) > 0 {
				cache[s.Category] = &snippets[0]
			}
		}
	}

	// Attach to suggestions.
	for i := range suggestions {
		if bp, ok := cache[suggestions[i].Category]; ok {
			suggestions[i].BestPractice = bp
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func hasNewDirs(diff diffInfo, config configState) bool {
	if !config.hasClaudeMD {
		return false
	}
	lowerSections := strings.ToLower(strings.Join(config.claudeMDSections, " "))
	for _, d := range diff.dirs {
		if !strings.Contains(lowerSections, strings.ToLower(d)) {
			return true
		}
	}
	return false
}

func hasRule(config configState, keyword string) bool {
	for _, r := range config.ruleNames {
		if strings.Contains(strings.ToLower(r), keyword) {
			return true
		}
	}
	return false
}

func hasRuleForExt(config configState, ext string) bool {
	lang := extLanguage(ext)
	return hasRule(config, lang) || hasRule(config, strings.TrimPrefix(ext, "."))
}

func uniqueExtensions(files []string) []string {
	seen := map[string]bool{}
	var exts []string
	for _, f := range files {
		ext := filepath.Ext(f)
		if ext != "" && !seen[ext] {
			seen[ext] = true
			exts = append(exts, ext)
		}
	}
	return exts
}

func isSignificantExt(ext string) bool {
	switch ext {
	case ".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".java", ".rb", ".swift", ".kt":
		return true
	}
	return false
}

func extLanguage(ext string) string {
	switch ext {
	case ".go":
		return "go"
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx":
		return "javascript"
	case ".py":
		return "python"
	case ".rs":
		return "rust"
	case ".java":
		return "java"
	case ".rb":
		return "ruby"
	case ".swift":
		return "swift"
	case ".kt":
		return "kotlin"
	default:
		return strings.TrimPrefix(ext, ".")
	}
}

