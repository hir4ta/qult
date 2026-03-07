package mcpserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
)

func reviewHandler(claudeHome string, st *store.Store, _ *embedder.Embedder) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")

		report := map[string]any{
			"project_path": projectPath,
		}

		// 1. Check CLAUDE.md
		report["claude_md"] = reviewClaudeMD(projectPath)

		// 2. Check .claude/ directory (skills, rules, agents)
		report["skills"] = reviewSkills(projectPath)
		report["rules"] = reviewRules(projectPath)
		report["agents"] = reviewDir(projectPath, ".claude", "agents")

		// 3. Check hooks (project-level .claude/hooks.json + user settings)
		report["hooks"] = reviewHooks(claudeHome, projectPath)

		// 4. Check MCP servers
		report["mcp_servers"] = reviewMCP(projectPath)

		// Generate improvement suggestions with KB cross-reference.
		suggestions := generateReviewSuggestions(report, st)
		report["suggestions"] = suggestions
		report["suggestion_count"] = len(suggestions)

		// Maturity scoring: score each category and compute overall.
		maturity := computeMaturityScore(report, suggestions)
		report["maturity"] = maturity
		if len(suggestions) == 0 {
			report["summary"] = "Good setup! CLAUDE.md, skills, rules, and hooks are all configured."
		}

		return marshalResult(report)
	}
}

// ---------------------------------------------------------------------------
// CLAUDE.md analysis
// ---------------------------------------------------------------------------

func reviewClaudeMD(projectPath string) map[string]any {
	result := map[string]any{"exists": false}
	if projectPath == "" {
		return result
	}

	path := filepath.Join(projectPath, "CLAUDE.md")
	data, err := os.ReadFile(path)
	if err != nil {
		return result
	}

	content := string(data)
	lines := countLines(content)
	sections := extractH2Sections(content)

	result["exists"] = true
	result["size_bytes"] = len(data)
	result["lines"] = lines
	result["sections"] = sections
	result["section_count"] = len(sections)

	if lines > 200 {
		result["size_warning"] = "large (>200 lines): consider splitting or trimming"
	}

	// Check for key sections.
	keyMap := map[string]bool{}
	lowerContent := strings.ToLower(content)
	for _, kw := range []string{"commands", "stack", "git", "rules", "structure"} {
		keyMap[kw] = strings.Contains(lowerContent, "## "+kw) ||
			strings.Contains(lowerContent, "## "+kw+"s") ||
			strings.Contains(lowerContent, "## "+kw+" ")
	}
	result["key_sections"] = keyMap

	return result
}

// extractH2Sections returns the list of ## header titles in markdown content.
func extractH2Sections(content string) []string {
	var sections []string
	for line := range strings.SplitSeq(content, "\n") {
		if rest, ok := strings.CutPrefix(line, "## "); ok {
			sections = append(sections, strings.TrimSpace(rest))
		}
	}
	return sections
}

// ---------------------------------------------------------------------------
// Skills analysis (with deep content inspection)
// ---------------------------------------------------------------------------

// skillInfo holds parsed metadata for a single skill.
type skillInfo struct {
	Name          string   `json:"name"`
	HasName       bool     `json:"has_name"`
	HasDesc       bool     `json:"has_description"`
	HasTrigger    bool     `json:"has_trigger"`
	HasAllowed    bool     `json:"has_allowed_tools"`
	UserInvocable bool    `json:"user_invocable"`
	BodyLines     int      `json:"body_lines"`
	SizeWarning   string   `json:"size_warning,omitempty"`
	HasSupport    bool     `json:"has_support_files"`
	AllowedTools  []string `json:"allowed_tools,omitempty"`
}

func reviewSkills(projectPath string) map[string]any {
	result := map[string]any{"count": 0}
	if projectPath == "" {
		return result
	}

	dir := filepath.Join(projectPath, ".claude", "skills")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return result
	}

	var skills []skillInfo
	var names []string
	var invalid []string

	for _, e := range entries {
		if e.IsDir() {
			skillFile := filepath.Join(dir, e.Name(), "SKILL.md")
			data, err := os.ReadFile(skillFile)
			if err != nil {
				continue
			}
			content := string(data)
			fm := parseSKILLFrontmatter(content)

			// Count body lines (after frontmatter).
			bodyLines := countBodyLines(content)

			// Parse allowed-tools into a slice.
			var allowedTools []string
			if raw := fm["allowed-tools"]; raw != "" {
				for _, t := range strings.Split(raw, ",") {
					t = strings.TrimSpace(t)
					if t != "" {
						allowedTools = append(allowedTools, t)
					}
				}
			}

			// Check for support files (anything besides SKILL.md in the skill dir).
			hasSupport := false
			skillDirEntries, _ := os.ReadDir(filepath.Join(dir, e.Name()))
			for _, se := range skillDirEntries {
				if se.Name() != "SKILL.md" {
					hasSupport = true
					break
				}
			}

			si := skillInfo{
				Name:          e.Name(),
				HasName:       fm["name"] != "",
				HasDesc:       fm["description"] != "",
				HasTrigger:    fm["trigger"] != "",
				HasAllowed:    fm["allowed-tools"] != "",
				UserInvocable: fm["user-invocable"] == "true",
				BodyLines:     bodyLines,
				HasSupport:    hasSupport,
				AllowedTools:  allowedTools,
			}

			if bodyLines > 150 {
				si.SizeWarning = "skill body exceeds 150 lines; consider splitting into support files"
			}

			skills = append(skills, si)
			names = append(names, e.Name())
			if !si.HasName || !si.HasDesc {
				invalid = append(invalid, e.Name())
			}
		} else if strings.HasSuffix(e.Name(), ".md") || strings.HasSuffix(e.Name(), ".yaml") {
			names = append(names, e.Name())
		}
	}

	result["count"] = len(names)
	if len(names) > 0 {
		result["items"] = names
	}
	if len(skills) > 0 {
		result["skill_details"] = skills
	}
	if len(invalid) > 0 {
		result["invalid_skills"] = invalid
	}
	return result
}

// countBodyLines counts lines after YAML frontmatter (--- delimited).
func countBodyLines(content string) int {
	lines := strings.Split(content, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return countLines(content)
	}
	// Find closing ---.
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			body := strings.Join(lines[i+1:], "\n")
			return countLines(strings.TrimSpace(body))
		}
	}
	return countLines(content)
}

// parseSKILLFrontmatter extracts YAML frontmatter fields from SKILL.md content.
// Handles --- delimited blocks. Returns empty map if no frontmatter found.
func parseSKILLFrontmatter(content string) map[string]string {
	result := make(map[string]string)

	lines := strings.Split(content, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return result
	}

	// Find closing ---
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return result
	}

	// Parse top-level key: value pairs (skip continuation lines starting with whitespace).
	for _, line := range lines[1:end] {
		if line == "" || (len(line) > 0 && (line[0] == ' ' || line[0] == '\t')) {
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		// Strip folded/literal scalar markers
		val = strings.TrimLeft(val, ">|")
		val = strings.TrimSpace(val)
		if key != "" {
			result[key] = val
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Rules analysis (with content inspection)
// ---------------------------------------------------------------------------

type ruleInfo struct {
	Name        string `json:"name"`
	Lines       int    `json:"lines"`
	HasGlob     bool   `json:"has_glob"`
	SizeWarning string `json:"size_warning,omitempty"`
}

func reviewRules(projectPath string) map[string]any {
	result := map[string]any{"count": 0}
	if projectPath == "" {
		return result
	}

	dir := filepath.Join(projectPath, ".claude", "rules")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return result
	}

	var names []string
	var details []ruleInfo

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		names = append(names, e.Name())

		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}

		content := string(data)
		lines := countLines(content)
		hasGlob := false

		// Check for glob frontmatter.
		fm := parseSKILLFrontmatter(content) // reuse YAML frontmatter parser
		if fm["globs"] != "" || fm["glob"] != "" {
			hasGlob = true
		}

		ri := ruleInfo{
			Name:    e.Name(),
			Lines:   lines,
			HasGlob: hasGlob,
		}
		if lines < 3 {
			ri.SizeWarning = "rule is too short to be useful"
		} else if lines > 100 {
			ri.SizeWarning = "rule exceeds 100 lines; consider splitting"
		}
		details = append(details, ri)
	}

	result["count"] = len(names)
	if len(names) > 0 {
		result["items"] = names
	}
	if len(details) > 0 {
		result["rule_details"] = details
	}
	return result
}

// ---------------------------------------------------------------------------
// Hooks analysis
// ---------------------------------------------------------------------------

// recommendedEvents lists hook events alfred should register for full functionality.
var recommendedEvents = []string{"SessionStart"}

func reviewHooks(claudeHome, projectPath string) map[string]any {
	result := map[string]any{"count": 0}

	allEvents := make(map[string]bool)

	// 1. Check project-level .claude/hooks.json (preferred location).
	if projectPath != "" {
		projectHooksPath := filepath.Join(projectPath, ".claude", "hooks.json")
		if data, err := os.ReadFile(projectHooksPath); err == nil {
			var hooksConfig struct {
				Hooks map[string]any `json:"hooks"`
			}
			if json.Unmarshal(data, &hooksConfig) == nil && hooksConfig.Hooks != nil {
				for event := range hooksConfig.Hooks {
					allEvents[event] = true
				}
				result["project_hooks"] = projectHooksPath
			}
		}
	}

	// 2. Check user-level settings.json (legacy/fallback).
	settingsPath := filepath.Join(claudeHome, "settings.json")
	if data, err := os.ReadFile(settingsPath); err == nil {
		var settings map[string]any
		if json.Unmarshal(data, &settings) == nil {
			if hooks, ok := settings["hooks"].(map[string]any); ok {
				for event := range hooks {
					allEvents[event] = true
				}
			}
		}
	}

	result["count"] = len(allEvents)
	events := make([]string, 0, len(allEvents))
	for event := range allEvents {
		events = append(events, event)
	}
	result["events"] = events

	// Check missing recommended events.
	var missing []string
	for _, ev := range recommendedEvents {
		if !allEvents[ev] {
			missing = append(missing, ev)
		}
	}
	if len(missing) > 0 {
		result["missing_recommended"] = missing
	}

	return result
}

// ---------------------------------------------------------------------------
// Directory listing (agents only — rules now uses reviewRules)
// ---------------------------------------------------------------------------

func reviewDir(projectPath, base, sub string) map[string]any {
	result := map[string]any{"count": 0}
	if projectPath == "" {
		return result
	}

	dir := filepath.Join(projectPath, base, sub)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return result
	}

	var names []string
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		} else {
			// Skills are directories containing SKILL.md
			skillFile := filepath.Join(dir, e.Name(), "SKILL.md")
			if _, err := os.Stat(skillFile); err == nil {
				names = append(names, e.Name())
			}
		}
	}

	result["count"] = len(names)
	if len(names) > 0 {
		result["items"] = names
	}
	return result
}

// ---------------------------------------------------------------------------
// MCP server analysis
// ---------------------------------------------------------------------------

func reviewMCP(projectPath string) map[string]any {
	result := map[string]any{"count": 0}
	if projectPath == "" {
		return result
	}

	mcpPath := filepath.Join(projectPath, ".mcp.json")
	data, err := os.ReadFile(mcpPath)
	if err != nil {
		return result
	}

	var mcpConfig map[string]any
	if err := json.Unmarshal(data, &mcpConfig); err != nil {
		return result
	}

	servers, ok := mcpConfig["mcpServers"].(map[string]any)
	if !ok {
		return result
	}

	result["count"] = len(servers)
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	result["servers"] = names
	return result
}

// ---------------------------------------------------------------------------
// Structured suggestions with KB cross-reference
// ---------------------------------------------------------------------------

// kbQueries maps suggestion categories to FTS5 queries for best practices.
var kbQueries = map[string]string{
	"claude_md": "CLAUDE.md best practices project instructions sections",
	"skills":    "skills SKILL.md frontmatter allowed-tools support files",
	"rules":     "rules coding standards configuration best practices",
	"hooks":     "hooks lifecycle events configuration automation",
}

func generateReviewSuggestions(report map[string]any, st *store.Store) []Suggestion {
	var suggestions []Suggestion

	// CLAUDE.md checks.
	claudeMD, _ := report["claude_md"].(map[string]any)
	if exists, _ := claudeMD["exists"].(bool); !exists {
		suggestions = append(suggestions, Suggestion{
			Severity: "warning",
			Category: "claude_md",
			Message:  "Create a CLAUDE.md file to give Claude Code project-specific instructions",
		})
	} else {
		if w, _ := claudeMD["size_warning"].(string); w != "" {
			suggestions = append(suggestions, Suggestion{
				Severity: "info",
				Category: "claude_md",
				Message:  "CLAUDE.md is " + w,
			})
		}
		if keySections, ok := claudeMD["key_sections"].(map[string]bool); ok {
			if !keySections["commands"] {
				suggestions = append(suggestions, Suggestion{
					Severity: "warning",
					Category: "claude_md",
					Message:  "CLAUDE.md: Add a ## Commands section listing common build/test commands",
				})
			}
		}
	}

	// Skills checks.
	skills, _ := report["skills"].(map[string]any)
	if count, _ := skills["count"].(int); count == 0 {
		suggestions = append(suggestions, Suggestion{
			Severity: "info",
			Category: "skills",
			Message:  "Add custom skills (.claude/skills/) to automate repetitive workflows",
		})
	} else {
		if invalid, ok := skills["invalid_skills"].([]string); ok && len(invalid) > 0 {
			suggestions = append(suggestions, Suggestion{
				Severity: "warning",
				Category: "skills",
				Message:  "Skills missing name or description in frontmatter: " + strings.Join(invalid, ", "),
				Affected: invalid,
			})
		}
		// Deep skill checks.
		if details, ok := skills["skill_details"].([]skillInfo); ok {
			for _, si := range details {
				if si.SizeWarning != "" {
					suggestions = append(suggestions, Suggestion{
						Severity: "warning",
						Category: "skills",
						Message:  "Skill '" + si.Name + "': " + si.SizeWarning,
						Affected: []string{".claude/skills/" + si.Name + "/SKILL.md"},
					})
				}
			}
		}
	}

	// Rules checks.
	rules, _ := report["rules"].(map[string]any)
	if count, _ := rules["count"].(int); count == 0 {
		suggestions = append(suggestions, Suggestion{
			Severity: "info",
			Category: "rules",
			Message:  "Add rules (.claude/rules/) to enforce coding standards automatically",
		})
	} else {
		if details, ok := rules["rule_details"].([]ruleInfo); ok {
			for _, ri := range details {
				if ri.SizeWarning != "" {
					suggestions = append(suggestions, Suggestion{
						Severity: "warning",
						Category: "rules",
						Message:  "Rule '" + ri.Name + "': " + ri.SizeWarning,
						Affected: []string{".claude/rules/" + ri.Name},
					})
				}
			}
		}
	}

	// Hooks checks.
	hooks, _ := report["hooks"].(map[string]any)
	if count, _ := hooks["count"].(int); count == 0 {
		suggestions = append(suggestions, Suggestion{
			Severity: "info",
			Category: "hooks",
			Message:  "Configure hooks for automated checks (tests, linting) on tool use",
		})
	} else {
		if missing, ok := hooks["missing_recommended"].([]string); ok && len(missing) > 0 {
			suggestions = append(suggestions, Suggestion{
				Severity: "warning",
				Category: "hooks",
				Message:  "Missing recommended alfred hook events: " + strings.Join(missing, ", "),
			})
		}
	}

	// Enrich suggestions with KB best practices.
	enrichWithKB(suggestions, st)

	return suggestions
}

// enrichWithKB attaches best practice snippets from the knowledge base to suggestions.
func enrichWithKB(suggestions []Suggestion, st *store.Store) {
	if st == nil || len(suggestions) == 0 {
		return
	}

	// Query KB once per category that has suggestions.
	categories := map[string]bool{}
	for _, s := range suggestions {
		categories[s.Category] = true
	}

	cache := map[string]*KBSnippet{}
	for cat := range categories {
		q, ok := kbQueries[cat]
		if !ok {
			continue
		}
		if snippets := queryKB(st, q, 1); len(snippets) > 0 {
			cache[cat] = &snippets[0]
		}
	}

	// Attach cached snippets to suggestions.
	for i := range suggestions {
		if bp, ok := cache[suggestions[i].Category]; ok {
			suggestions[i].BestPractice = bp
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// computeMaturityScore derives a 0-100 score per category and overall from the review report.
func computeMaturityScore(report map[string]any, suggestions []Suggestion) map[string]any {
	scores := map[string]int{
		"claude_md": 0,
		"skills":    0,
		"rules":     0,
		"hooks":     0,
		"mcp":       0,
	}

	// CLAUDE.md: exists=40, no size warning=20, has commands section=20, sections>2=20
	if cm, ok := report["claude_md"].(map[string]any); ok {
		if exists, _ := cm["exists"].(bool); exists {
			scores["claude_md"] += 40
			if _, hasWarning := cm["size_warning"]; !hasWarning {
				scores["claude_md"] += 20
			}
			if ks, ok := cm["key_sections"].(map[string]bool); ok && ks["commands"] {
				scores["claude_md"] += 20
			}
			if sc, _ := cm["section_count"].(int); sc > 2 {
				scores["claude_md"] += 20
			}
		}
	}

	// Skills: count>0=40, all valid frontmatter=30, no size warnings=30
	if sk, ok := report["skills"].(map[string]any); ok {
		if count, _ := sk["count"].(int); count > 0 {
			scores["skills"] += 40
			if _, hasInvalid := sk["invalid_skills"]; !hasInvalid {
				scores["skills"] += 30
			}
			hasWarning := false
			if details, ok := sk["skill_details"].([]skillInfo); ok {
				for _, si := range details {
					if si.SizeWarning != "" {
						hasWarning = true
						break
					}
				}
			}
			if !hasWarning {
				scores["skills"] += 30
			}
		}
	}

	// Rules: count>0=50, no size warnings=50
	if ru, ok := report["rules"].(map[string]any); ok {
		if count, _ := ru["count"].(int); count > 0 {
			scores["rules"] += 50
			hasWarning := false
			if details, ok := ru["rule_details"].([]ruleInfo); ok {
				for _, ri := range details {
					if ri.SizeWarning != "" {
						hasWarning = true
						break
					}
				}
			}
			if !hasWarning {
				scores["rules"] += 50
			}
		}
	}

	// Hooks: count>0=60, no missing recommended=40
	if hk, ok := report["hooks"].(map[string]any); ok {
		if count, _ := hk["count"].(int); count > 0 {
			scores["hooks"] += 60
			if _, hasMissing := hk["missing_recommended"]; !hasMissing {
				scores["hooks"] += 40
			}
		}
	}

	// MCP: count>0=100
	if mc, ok := report["mcp_servers"].(map[string]any); ok {
		if count, _ := mc["count"].(int); count > 0 {
			scores["mcp"] = 100
		}
	}

	// Deduct for warnings.
	for _, s := range suggestions {
		if s.Severity == "warning" {
			scores[s.Category] = max(scores[s.Category]-10, 0)
		}
	}

	total := 0
	for _, v := range scores {
		total += v
	}
	overall := total / len(scores)

	return map[string]any{
		"overall":  overall,
		"scores":   scores,
		"warnings": countSeverity(suggestions, "warning"),
		"info":     countSeverity(suggestions, "info"),
	}
}

func countSeverity(suggestions []Suggestion, severity string) int {
	n := 0
	for _, s := range suggestions {
		if s.Severity == severity {
			n++
		}
	}
	return n
}

func countLines(s string) int {
	n := 0
	for _, c := range s {
		if c == '\n' {
			n++
		}
	}
	if len(s) > 0 && s[len(s)-1] != '\n' {
		n++
	}
	return n
}
