package mcpserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func reviewHandler(claudeHome string) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		projectPath := req.GetString("project_path", "")

		report := map[string]any{
			"project_path": projectPath,
		}

		// 1. Check CLAUDE.md
		report["claude_md"] = reviewClaudeMD(projectPath)

		// 2. Check .claude/ directory (skills, rules, agents)
		report["skills"] = reviewSkills(projectPath)
		report["rules"] = reviewDir(projectPath, ".claude", "rules")
		report["agents"] = reviewDir(projectPath, ".claude", "agents")

		// 3. Check hooks in settings.json
		report["hooks"] = reviewHooks(claudeHome)

		// 4. Check MCP servers
		report["mcp_servers"] = reviewMCP(projectPath)

		// Generate improvement suggestions.
		formatReviewSuggestions(report)

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
// Skills analysis (with frontmatter validation)
// ---------------------------------------------------------------------------

// skillInfo holds parsed metadata for a single skill.
type skillInfo struct {
	Name          string `json:"name"`
	HasName       bool   `json:"has_name"`
	HasDesc       bool   `json:"has_description"`
	HasTrigger    bool   `json:"has_trigger"`
	HasAllowed    bool   `json:"has_allowed_tools"`
	UserInvocable bool   `json:"user_invocable"`
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
			fm := parseSKILLFrontmatter(string(data))
			si := skillInfo{
				Name:          e.Name(),
				HasName:       fm["name"] != "",
				HasDesc:       fm["description"] != "",
				HasTrigger:    fm["trigger"] != "",
				HasAllowed:    fm["allowed-tools"] != "",
				UserInvocable: fm["user-invocable"] == "true",
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
// Hooks analysis
// ---------------------------------------------------------------------------

// recommendedEvents lists hook events alfred should register for full functionality.
var recommendedEvents = []string{"SessionStart"}

func reviewHooks(claudeHome string) map[string]any {
	result := map[string]any{"count": 0}

	settingsPath := filepath.Join(claudeHome, "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return result
	}

	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return result
	}

	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		return result
	}

	result["count"] = len(hooks)
	events := make([]string, 0, len(hooks))
	for event := range hooks {
		events = append(events, event)
	}
	result["events"] = events

	// Check missing recommended events.
	var missing []string
	for _, ev := range recommendedEvents {
		if _, ok := hooks[ev]; !ok {
			missing = append(missing, ev)
		}
	}
	if len(missing) > 0 {
		result["missing_recommended"] = missing
	}

	return result
}

// ---------------------------------------------------------------------------
// Directory listing (rules, agents)
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
// Improvement suggestions
// ---------------------------------------------------------------------------

func formatReviewSuggestions(report map[string]any) {
	var suggestions []string

	// CLAUDE.md checks
	claudeMD, _ := report["claude_md"].(map[string]any)
	if exists, _ := claudeMD["exists"].(bool); !exists {
		suggestions = append(suggestions, "Create a CLAUDE.md file to give Claude Code project-specific instructions")
	} else {
		if w, _ := claudeMD["size_warning"].(string); w != "" {
			suggestions = append(suggestions, "CLAUDE.md is "+w)
		}
		if keySections, ok := claudeMD["key_sections"].(map[string]bool); ok {
			if !keySections["commands"] {
				suggestions = append(suggestions, "CLAUDE.md: Add a ## Commands section listing common build/test commands")
			}
		}
	}

	// Skills checks
	skills, _ := report["skills"].(map[string]any)
	if count, _ := skills["count"].(int); count == 0 {
		suggestions = append(suggestions, "Add custom skills (.claude/skills/) to automate repetitive workflows")
	} else if invalid, ok := skills["invalid_skills"].([]string); ok && len(invalid) > 0 {
		suggestions = append(suggestions, "Skills missing name or description in frontmatter: "+strings.Join(invalid, ", "))
	}

	// Rules checks
	rules, _ := report["rules"].(map[string]any)
	if count, _ := rules["count"].(int); count == 0 {
		suggestions = append(suggestions, "Add rules (.claude/rules/) to enforce coding standards automatically")
	}

	// Hooks checks
	hooks, _ := report["hooks"].(map[string]any)
	if count, _ := hooks["count"].(int); count == 0 {
		suggestions = append(suggestions, "Configure hooks for automated checks (tests, linting) on tool use")
	} else {
		if missing, ok := hooks["missing_recommended"].([]string); ok && len(missing) > 0 {
			suggestions = append(suggestions, "Missing recommended alfred hook events: "+strings.Join(missing, ", "))
		}
	}

	if len(suggestions) > 0 {
		report["suggestions"] = suggestions
		report["suggestion_count"] = len(suggestions)
	} else {
		report["suggestions"] = []string{}
		report["suggestion_count"] = 0
		report["summary"] = "Good setup! CLAUDE.md, skills, rules, and hooks are all configured."
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
